import { and, asc, eq, isNotNull, isNull, lte, notExists, sql } from "drizzle-orm";

import type { AppBindings } from "../bindings";
import { type PacaDatabase, withDatabase } from "../database";
import {
  pacaAutomationEventOutbox,
  pacaAutomationNodes,
  pacaAutomations,
  pacaProjects,
  pacaTasks,
} from "../db/schema";
import { dueDateTriggerConfigFromNode } from "./execution-plan";

export interface AutomationDueDateRepository {
  captureDue(now: Date, limit: number): Promise<{ created: number }>;
}

export class PostgresAutomationDueDateRepository implements AutomationDueDateRepository {
  constructor(private readonly database: PacaDatabase) {}

  async captureDue(now: Date, limit: number): Promise<{ created: number }> {
    // PostgreSQL date/interval arithmetic and a correlated NOT EXISTS cannot be
    // expressed by the portable builder. Explicit UTC keeps database/session
    // timezone and daylight-saving changes out of the date-only task contract.
    const offset = sql<number>`case when coalesce(${pacaAutomationNodes.config}->>'due_date_offset_minutes', '0') ~ '^-?[0-9]{1,6}$'
      then coalesce(${pacaAutomationNodes.config}->>'due_date_offset_minutes', '0')::integer else null end`;
    const scheduledFor = sql`(${pacaTasks.dueDate}::timestamp at time zone 'UTC') + (${offset}) * interval '1 minute'`;
    const scheduleKey = sql<string>`concat('due:', ${pacaAutomationNodes.id}, ':', ${pacaAutomations.graphVersion}, ':', ${pacaTasks.id}, ':', to_char(${pacaTasks.dueDate}, 'YYYY-MM-DD'))`;
    // Capture and deduplicate in one transaction. Unique schedule keys arbitrate
    // overlapping cron invocations; skipped duplicates never consume the next
    // scan's batch. No Valkey lock or in-memory cursor is required for recovery.
    return this.database.transaction(async (tx) => {
      const candidates = await tx
        .select({
          projectId: pacaAutomations.projectId,
          graphVersion: pacaAutomations.graphVersion,
          graphUpdatedAt: pacaAutomations.updatedAt,
          trigger: pacaAutomationNodes,
          taskId: pacaTasks.id,
          dueDate: pacaTasks.dueDate,
          scheduleKey: scheduleKey.as("schedule_key"),
        })
        .from(pacaAutomations)
        .innerJoin(pacaProjects, eq(pacaProjects.id, pacaAutomations.projectId))
        .innerJoin(pacaAutomationNodes, eq(pacaAutomationNodes.automationId, pacaAutomations.id))
        .innerJoin(pacaTasks, eq(pacaTasks.projectId, pacaAutomations.projectId))
        .where(
          and(
            eq(pacaAutomations.status, "active"),
            isNull(pacaAutomations.deletedAt),
            eq(pacaProjects.status, "active"),
            eq(pacaAutomationNodes.kind, "trigger"),
            eq(pacaAutomationNodes.type, "due_date_reached"),
            isNull(pacaTasks.deletedAt),
            isNotNull(pacaTasks.dueDate),
            // Coarse indexed date bound before applying the node's exact offset.
            lte(
              pacaTasks.dueDate,
              new Date(now.getTime() + 525_600 * 60_000).toISOString().slice(0, 10),
            ),
            sql`${offset} between -525600 and 525600`,
            lte(scheduledFor, now.toISOString()),
            notExists(
              tx
                .select({ id: pacaAutomationEventOutbox.id })
                .from(pacaAutomationEventOutbox)
                .where(eq(pacaAutomationEventOutbox.scheduleKey, scheduleKey)),
            ),
          ),
        )
        .orderBy(asc(pacaTasks.dueDate), asc(pacaAutomationNodes.id), asc(pacaTasks.id))
        .limit(limit);
      if (candidates.length === 0) return { created: 0 };
      const createdAt = new Date();
      const rows = await tx
        .insert(pacaAutomationEventOutbox)
        .values(
          candidates.map((candidate) => {
            const config = dueDateTriggerConfigFromNode(candidate.trigger);
            if (!candidate.dueDate) throw new Error("AUTOMATION_DUE_DATE_MISSING");
            return {
              projectId: candidate.projectId,
              taskId: candidate.taskId,
              eventType: "due_date_reached",
              scheduleKey: candidate.scheduleKey,
              createdAt: new Date(
                Math.max(createdAt.getTime(), candidate.graphUpdatedAt.getTime()),
              ),
              payload: {
                trigger_node_id: candidate.trigger.id,
                graph_version: candidate.graphVersion,
                due_date: candidate.dueDate,
                due_date_offset_minutes: config.due_date_offset_minutes,
                scheduled_for: new Date(
                  Date.parse(`${candidate.dueDate}T00:00:00.000Z`) +
                    config.due_date_offset_minutes * 60_000,
                ).toISOString(),
              },
            };
          }),
        )
        .onConflictDoNothing({ target: pacaAutomationEventOutbox.scheduleKey })
        .returning({ id: pacaAutomationEventOutbox.id });
      return { created: rows.length };
    });
  }
}

export async function runScheduledAutomationDueDates(
  env: AppBindings,
  now: Date,
  options: { repository?: AutomationDueDateRepository; limit?: number } = {},
): Promise<{ created: number }> {
  if (!Number.isFinite(now.getTime())) throw new Error("AUTOMATION_SCHEDULE_TIME_INVALID");
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("AUTOMATION_SCHEDULE_LIMIT_INVALID");
  if (options.repository) return options.repository.captureDue(now, limit);
  return withDatabase(env, (database) =>
    new PostgresAutomationDueDateRepository(database).captureDue(now, limit),
  );
}
