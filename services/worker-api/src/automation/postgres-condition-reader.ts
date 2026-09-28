import { and, eq, inArray, isNull, or } from "drizzle-orm";

import type { PacaDatabase } from "../database";
import { pacaSprints, pacaTaskAssignees, pacaTaskLinks, pacaTasks } from "../db/schema";
import { taskFromRow } from "../task/postgres-repository";
import type { Task } from "../task/service";
import {
  type ConditionLeaf,
  type ConditionSprint,
  type ConditionTarget,
  conditionConfigFromNode,
  evaluateConditionLeaf,
  isSprintConditionField,
} from "./condition";
import { AutomationExecutionError } from "./errors";
import type { SnapshotNode } from "./execution-plan";

type TaskRow = typeof pacaTasks.$inferSelect;
const MAX_TARGET_TASKS = 100;

/** Reads one consistent project-scoped view for a condition Workflow step. */
export class PostgresAutomationConditionReader {
  constructor(private readonly database: PacaDatabase) {}

  async selectHandle(projectId: string, taskId: string, node: SnapshotNode): Promise<string> {
    const config = conditionConfigFromNode(node);
    return this.database.transaction(
      async (tx) => {
        const [baseRow] = await tx
          .select()
          .from(pacaTasks)
          .where(
            and(
              eq(pacaTasks.id, taskId),
              eq(pacaTasks.projectId, projectId),
              isNull(pacaTasks.deletedAt),
            ),
          );
        if (!baseRow) throw new AutomationExecutionError("AUTOMATION_TASK_NOT_FOUND");

        const loadTasks = async (rows: TaskRow[]): Promise<Task[]> => {
          if (rows.length === 0) return [];
          const assignees = await tx
            .select({ taskId: pacaTaskAssignees.taskId, memberId: pacaTaskAssignees.memberId })
            .from(pacaTaskAssignees)
            .where(
              inArray(
                pacaTaskAssignees.taskId,
                rows.map((row) => row.id),
              ),
            );
          const byTask = new Map<string, string[]>();
          for (const assignee of assignees) {
            const ids = byTask.get(assignee.taskId) ?? [];
            ids.push(assignee.memberId);
            byTask.set(assignee.taskId, ids);
          }
          return rows.map((row) => taskFromRow(row, byTask.get(row.id) ?? []));
        };

        const rowsByIds = async (ids: string[]): Promise<TaskRow[]> => {
          const unique = [...new Set(ids)];
          if (unique.length === 0) return [];
          if (unique.length > MAX_TARGET_TASKS) {
            throw new AutomationExecutionError("AUTOMATION_CONDITION_TARGET_LIMIT");
          }
          return tx
            .select()
            .from(pacaTasks)
            .where(
              and(
                eq(pacaTasks.projectId, projectId),
                inArray(pacaTasks.id, unique),
                isNull(pacaTasks.deletedAt),
              ),
            );
        };

        const resolveTargets = async (target: ConditionTarget | undefined): Promise<Task[]> => {
          const kind = target?.kind ?? "self";
          if (kind === "self") return loadTasks([baseRow]);
          if (kind === "parent") {
            return loadTasks(await rowsByIds(baseRow.parentTaskId ? [baseRow.parentTaskId] : []));
          }
          if (kind === "other") {
            return loadTasks(await rowsByIds(target?.other_task_id ? [target.other_task_id] : []));
          }
          if (kind === "children") {
            const rows = await tx
              .select()
              .from(pacaTasks)
              .where(
                and(
                  eq(pacaTasks.projectId, projectId),
                  eq(pacaTasks.parentTaskId, taskId),
                  isNull(pacaTasks.deletedAt),
                ),
              )
              .limit(MAX_TARGET_TASKS + 1);
            if (rows.length > MAX_TARGET_TASKS) {
              throw new AutomationExecutionError("AUTOMATION_CONDITION_TARGET_LIMIT");
            }
            return loadTasks(rows);
          }

          const linkType =
            kind === "blocks" || kind === "is_blocked_by"
              ? "blocks"
              : kind === "relates_to"
                ? "relates_to"
                : "duplicates";
          const perspective =
            kind === "relates_to"
              ? or(eq(pacaTaskLinks.sourceTaskId, taskId), eq(pacaTaskLinks.targetTaskId, taskId))
              : kind === "blocks" || kind === "duplicates"
                ? eq(pacaTaskLinks.sourceTaskId, taskId)
                : eq(pacaTaskLinks.targetTaskId, taskId);
          const links = await tx
            .select({
              sourceTaskId: pacaTaskLinks.sourceTaskId,
              targetTaskId: pacaTaskLinks.targetTaskId,
            })
            .from(pacaTaskLinks)
            .where(
              and(
                eq(pacaTaskLinks.projectId, projectId),
                eq(pacaTaskLinks.linkType, linkType),
                perspective,
              ),
            )
            .limit(MAX_TARGET_TASKS + 1);
          if (links.length > MAX_TARGET_TASKS) {
            throw new AutomationExecutionError("AUTOMATION_CONDITION_TARGET_LIMIT");
          }
          const ids = links.map((link) =>
            link.sourceTaskId === taskId ? link.targetTaskId : link.sourceTaskId,
          );
          return loadTasks(await rowsByIds(ids));
        };

        const [baseTask] = await loadTasks([baseRow]);
        if (!baseTask) throw new AutomationExecutionError("AUTOMATION_TASK_NOT_FOUND");
        let sprint: ConditionSprint | null | undefined;
        const loadSprint = async (): Promise<ConditionSprint | null> => {
          if (sprint !== undefined) return sprint;
          if (!baseTask.sprintId) {
            sprint = null;
            return sprint;
          }
          const [row] = await tx
            .select({
              name: pacaSprints.name,
              status: pacaSprints.status,
              goal: pacaSprints.goal,
              startDate: pacaSprints.startDate,
              endDate: pacaSprints.endDate,
            })
            .from(pacaSprints)
            .where(
              and(eq(pacaSprints.id, baseTask.sprintId), eq(pacaSprints.projectId, projectId)),
            );
          sprint = row ?? null;
          return sprint;
        };

        for (const branch of config.branches) {
          const leaf: ConditionLeaf | null | undefined = branch.tree;
          if (!leaf) return branch.handle;
          if (isSprintConditionField(leaf.field)) {
            if (evaluateConditionLeaf(leaf, null, await loadSprint())) return branch.handle;
            continue;
          }
          const tasks = await resolveTargets(leaf.target);
          if (tasks.length === 0) continue;
          const matched =
            leaf.match_mode === "all"
              ? tasks.every((task) => evaluateConditionLeaf(leaf, task, null))
              : tasks.some((task) => evaluateConditionLeaf(leaf, task, null));
          if (matched) return branch.handle;
        }
        return "else";
      },
      { isolationLevel: "repeatable read" },
    );
  }
}
