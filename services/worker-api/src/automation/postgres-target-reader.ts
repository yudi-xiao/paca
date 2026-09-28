import { and, eq, inArray, isNull, or } from "drizzle-orm";

import type { PacaDatabase } from "../database";
import { pacaTaskLinks, pacaTasks } from "../db/schema";
import type { ConditionTarget } from "./condition";
import { AutomationExecutionError } from "./errors";

const MAX_ACTION_TARGETS = 100;

/** Freezes a bounded, project-scoped target set before any fan-out writes. */
export class PostgresAutomationTargetReader {
  constructor(private readonly database: PacaDatabase) {}

  async resolveTaskIds(
    projectId: string,
    baseTaskId: string,
    target: ConditionTarget,
  ): Promise<string[]> {
    return this.database.transaction(
      async (tx) => {
        const [base] = await tx
          .select({ id: pacaTasks.id, parentTaskId: pacaTasks.parentTaskId })
          .from(pacaTasks)
          .where(
            and(
              eq(pacaTasks.id, baseTaskId),
              eq(pacaTasks.projectId, projectId),
              isNull(pacaTasks.deletedAt),
            ),
          );
        if (!base) throw new AutomationExecutionError("AUTOMATION_TASK_NOT_FOUND");
        if (target.kind === "self") return [base.id];

        const existingIds = async (ids: string[]): Promise<string[]> => {
          const unique = [...new Set(ids)];
          if (unique.length === 0) return [];
          if (unique.length > MAX_ACTION_TARGETS) {
            throw new AutomationExecutionError("AUTOMATION_ACTION_TARGET_LIMIT");
          }
          const rows = await tx
            .select({ id: pacaTasks.id })
            .from(pacaTasks)
            .where(
              and(
                eq(pacaTasks.projectId, projectId),
                inArray(pacaTasks.id, unique),
                isNull(pacaTasks.deletedAt),
              ),
            );
          return rows.map(({ id }) => id).sort();
        };

        if (target.kind === "parent") {
          return existingIds(base.parentTaskId ? [base.parentTaskId] : []);
        }
        if (target.kind === "other") {
          const ids = await existingIds(target.other_task_id ? [target.other_task_id] : []);
          if (ids.length !== 1) throw new AutomationExecutionError("AUTOMATION_TARGET_NOT_FOUND");
          return ids;
        }
        if (target.kind === "children") {
          const rows = await tx
            .select({ id: pacaTasks.id })
            .from(pacaTasks)
            .where(
              and(
                eq(pacaTasks.projectId, projectId),
                eq(pacaTasks.parentTaskId, baseTaskId),
                isNull(pacaTasks.deletedAt),
              ),
            )
            .limit(MAX_ACTION_TARGETS + 1);
          if (rows.length > MAX_ACTION_TARGETS) {
            throw new AutomationExecutionError("AUTOMATION_ACTION_TARGET_LIMIT");
          }
          return rows.map(({ id }) => id).sort();
        }

        const linkType =
          target.kind === "blocks" || target.kind === "is_blocked_by"
            ? "blocks"
            : target.kind === "relates_to"
              ? "relates_to"
              : "duplicates";
        const perspective =
          target.kind === "relates_to"
            ? or(
                eq(pacaTaskLinks.sourceTaskId, baseTaskId),
                eq(pacaTaskLinks.targetTaskId, baseTaskId),
              )
            : target.kind === "blocks" || target.kind === "duplicates"
              ? eq(pacaTaskLinks.sourceTaskId, baseTaskId)
              : eq(pacaTaskLinks.targetTaskId, baseTaskId);
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
          .limit(MAX_ACTION_TARGETS + 1);
        if (links.length > MAX_ACTION_TARGETS) {
          throw new AutomationExecutionError("AUTOMATION_ACTION_TARGET_LIMIT");
        }
        return existingIds(
          links.map((link) =>
            link.sourceTaskId === baseTaskId ? link.targetTaskId : link.sourceTaskId,
          ),
        );
      },
      { isolationLevel: "repeatable read" },
    );
  }
}
