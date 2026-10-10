import { and, eq, isNull } from "drizzle-orm";
import { renderAutomationText } from "../automation/template";
import type { PacaDatabase } from "../database";
import {
  pacaAutomationRunSteps,
  pacaAutomationRuns,
  pacaAutomations,
  pacaProjects,
  pacaSprints,
  pacaTasks,
} from "../db/schema";
import { automationTaskActor } from "../task/service";
import {
  type SprintActionResult,
  type SprintAutomationAction,
  type SprintAutomationRepository,
  sprintActionResultSchema,
} from "./automation";
import { completeSprintInTransaction, sprintFromRow } from "./postgres-repository";
import { IterationError, iterationErrorCodes, normalizeSprintUpdate } from "./service";

export class PostgresSprintAutomationRepository implements SprintAutomationRepository {
  constructor(private readonly database: PacaDatabase) {}
  async resolveSprint(
    projectId: string,
    taskId: string | null,
    contextSprintId: string | null,
  ): Promise<string> {
    let sprintId = contextSprintId;
    if (!sprintId && taskId) {
      const [task] = await this.database
        .select({ sprintId: pacaTasks.sprintId })
        .from(pacaTasks)
        .where(
          and(
            eq(pacaTasks.id, taskId),
            eq(pacaTasks.projectId, projectId),
            isNull(pacaTasks.deletedAt),
          ),
        );
      if (!task) throw new Error("AUTOMATION_TASK_NOT_FOUND");
      sprintId = task.sprintId;
    }
    if (!sprintId) throw new Error("AUTOMATION_SPRINT_CONTEXT_MISSING");
    const [sprint] = await this.database
      .select({ id: pacaSprints.id })
      .from(pacaSprints)
      .where(and(eq(pacaSprints.id, sprintId), eq(pacaSprints.projectId, projectId)));
    if (!sprint) throw new IterationError(iterationErrorCodes.sprintNotFound);
    return sprint.id;
  }
  async apply(action: SprintAutomationAction): Promise<SprintActionResult> {
    return this.database.transaction(async (tx) => {
      const [run] = await tx
        .select({
          id: pacaAutomationRuns.id,
          status: pacaAutomationRuns.status,
          automationName: pacaAutomations.name,
          snapshot: pacaAutomationRuns.graphSnapshot,
        })
        .from(pacaAutomationRuns)
        .innerJoin(pacaAutomations, eq(pacaAutomations.id, pacaAutomationRuns.automationId))
        .where(
          and(
            eq(pacaAutomationRuns.id, action.runId),
            eq(pacaAutomations.projectId, action.projectId),
          ),
        )
        .for("update", { of: pacaAutomationRuns });
      if (!run) throw new Error("AUTOMATION_RUN_NOT_FOUND");
      const [completed] = await tx
        .select()
        .from(pacaAutomationRunSteps)
        .where(
          and(
            eq(pacaAutomationRunSteps.runId, action.runId),
            eq(pacaAutomationRunSteps.stepKey, action.nodeId),
          ),
        );
      if (completed) {
        if (completed.status !== "completed") throw new Error("AUTOMATION_SPRINT_STEP_INVALID");
        return sprintActionResultSchema.parse(completed.outputSnapshot);
      }
      if (run.status !== "running") throw new Error("AUTOMATION_RUN_NOT_RUNNING");
      const [project] = await tx
        .select({ id: pacaProjects.id })
        .from(pacaProjects)
        .where(and(eq(pacaProjects.id, action.projectId), eq(pacaProjects.status, "active")))
        .for("share");
      if (!project) throw new Error("AUTOMATION_PROJECT_NOT_FOUND");
      let result: SprintActionResult;
      if (action.type === "complete_sprint") {
        const completed = await completeSprintInTransaction(
          tx,
          action.projectId,
          action.sprintId,
          action.destinationSprintId,
          automationTaskActor(action.runId),
          true,
        );
        result = {
          sprint_id: action.sprintId,
          applied: completed.applied,
          moved_task_count: completed.movedTasks,
          changes: completed.applied
            ? [{ field: "status", old: completed.before.status, new: completed.updated.status }]
            : [],
        };
      } else {
        const [current] = await tx
          .select()
          .from(pacaSprints)
          .where(
            and(eq(pacaSprints.id, action.sprintId), eq(pacaSprints.projectId, action.projectId)),
          )
          .for("update");
        if (!current) throw new IterationError(iterationErrorCodes.sprintNotFound);
        const vars: Record<string, string> = {
          "automation.name":
            typeof run.snapshot.automationName === "string"
              ? run.snapshot.automationName
              : run.automationName,
          "sprint.id": current.id,
          "sprint.name": current.name,
          "sprint.status": current.status,
        };
        if (current.goal !== null) vars["sprint.goal"] = current.goal;
        if (current.startDate) vars["sprint.start_date"] = `${current.startDate}T00:00:00Z`;
        if (current.endDate) vars["sprint.end_date"] = `${current.endDate}T00:00:00Z`;
        if (action.taskId) {
          const [task] = await tx
            .select()
            .from(pacaTasks)
            .where(
              and(
                eq(pacaTasks.id, action.taskId),
                eq(pacaTasks.projectId, action.projectId),
                isNull(pacaTasks.deletedAt),
              ),
            );
          if (!task) throw new Error("AUTOMATION_TASK_NOT_FOUND");
          Object.assign(vars, {
            "task.id": task.id,
            "task.title": task.title,
            "task.importance": String(task.importance),
            "task.tags": task.tags.join(", "),
          });
          if (task.storyPoints !== null) vars["task.story_points"] = String(task.storyPoints);
          if (task.sprintId) vars["task.sprint_id"] = task.sprintId;
        }
        const update = { ...action.update };
        if (update.name !== undefined) update.name = renderAutomationText(update.name, vars);
        if (update.goal !== undefined && update.goal !== null)
          update.goal = renderAutomationText(update.goal, vars);
        const normalized = normalizeSprintUpdate(sprintFromRow(current), update);
        const changes = Object.entries(normalized).flatMap(([key, value]) =>
          current[key as keyof typeof normalized] === value
            ? []
            : [
                {
                  field: key,
                  old: current[key as keyof typeof normalized] ?? null,
                  new: value ?? null,
                },
              ],
        );
        if (changes.length)
          await tx
            .update(pacaSprints)
            .set({ ...normalized, updatedAt: new Date() })
            .where(eq(pacaSprints.id, current.id));
        result = {
          sprint_id: current.id,
          applied: changes.length > 0,
          moved_task_count: 0,
          changes,
        };
      }
      // The step is both business audit and deduplication authority. It commits
      // with all Sprint/task writes and their outbox events, before replying.
      await tx.insert(pacaAutomationRunSteps).values({
        runId: action.runId,
        nodeId: action.nodeId,
        stepKey: action.nodeId,
        status: "completed",
        inputSnapshot: {
          action: action.type,
          actor_type: "system",
          actor_id: "system",
          sprint_id: action.sprintId,
          fields: action.type === "update_sprint" ? Object.keys(action.update) : ["status"],
          ...(action.type === "complete_sprint"
            ? { move_to_sprint_id: action.destinationSprintId }
            : {}),
        },
        outputSnapshot: result,
      });
      return result;
    });
  }
}
