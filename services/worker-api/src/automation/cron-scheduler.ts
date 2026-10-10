import { and, asc, eq, isNull, lte } from "drizzle-orm";
import type { AppBindings } from "../bindings";
import { type PacaDatabase, withDatabase } from "../database";
import {
  pacaAutomationEventOutbox,
  pacaAutomationNodes,
  pacaAutomations,
  pacaProjects,
} from "../db/schema";
import { cronTriggerConfig, latestCronOccurrence, nextCronOccurrence } from "./cron";

export interface AutomationCronRepository {
  captureDue(now: Date, limit: number): Promise<{ created: number }>;
}

export class PostgresAutomationCronRepository implements AutomationCronRepository {
  constructor(private readonly database: PacaDatabase) {}

  async captureDue(now: Date, limit: number): Promise<{ created: number }> {
    return this.database.transaction(async (tx) => {
      const nodes = await tx
        .select({
          trigger: pacaAutomationNodes,
          projectId: pacaAutomations.projectId,
          graphVersion: pacaAutomations.graphVersion,
          graphUpdatedAt: pacaAutomations.updatedAt,
        })
        .from(pacaAutomationNodes)
        .innerJoin(pacaAutomations, eq(pacaAutomations.id, pacaAutomationNodes.automationId))
        .innerJoin(pacaProjects, eq(pacaProjects.id, pacaAutomations.projectId))
        .where(
          and(
            eq(pacaAutomationNodes.kind, "trigger"),
            eq(pacaAutomationNodes.type, "cron"),
            lte(pacaAutomationNodes.nextScheduledAt, now),
            eq(pacaAutomations.status, "active"),
            isNull(pacaAutomations.deletedAt),
            eq(pacaProjects.status, "active"),
          ),
        )
        .orderBy(asc(pacaAutomationNodes.nextScheduledAt), asc(pacaAutomationNodes.id))
        .limit(limit)
        .for("update", { of: pacaAutomationNodes, skipLocked: true });
      let created = 0;
      for (const candidate of nodes) {
        const config = cronTriggerConfig(candidate.trigger.config);
        const occurrence = latestCronOccurrence(config.cron_expression, now);
        if (!candidate.trigger.nextScheduledAt || occurrence < candidate.trigger.nextScheduledAt)
          throw new Error("AUTOMATION_CRON_CURSOR_INVALID");
        const rows = await tx
          .insert(pacaAutomationEventOutbox)
          .values({
            projectId: candidate.projectId,
            taskId: config.target_task_id ?? null,
            eventType: "cron",
            scheduleKey: `cron:${candidate.trigger.id}:${candidate.graphVersion}:${occurrence.toISOString()}`,
            createdAt: new Date(Math.max(Date.now(), candidate.graphUpdatedAt.getTime())),
            payload: {
              trigger_node_id: candidate.trigger.id,
              graph_version: candidate.graphVersion,
              cron_expression: config.cron_expression,
              scheduled_for: occurrence.toISOString(),
            },
          })
          .onConflictDoNothing({ target: pacaAutomationEventOutbox.scheduleKey })
          .returning({ id: pacaAutomationEventOutbox.id });
        created += rows.length;
        // This cursor advances only with the committed outbox event. A failed
        // transaction can be retried, without drifting off the schedule's grid.
        await tx
          .update(pacaAutomationNodes)
          .set({ nextScheduledAt: nextCronOccurrence(config.cron_expression, now) })
          .where(eq(pacaAutomationNodes.id, candidate.trigger.id));
      }
      return { created };
    });
  }
}

export async function runScheduledAutomationCron(
  env: AppBindings,
  now: Date,
  options: { repository?: AutomationCronRepository; limit?: number } = {},
): Promise<{ created: number }> {
  if (!Number.isFinite(now.getTime())) throw new Error("AUTOMATION_SCHEDULE_TIME_INVALID");
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("AUTOMATION_SCHEDULE_LIMIT_INVALID");
  if (options.repository) return options.repository.captureDue(now, limit);
  return withDatabase(env, (database) =>
    new PostgresAutomationCronRepository(database).captureDue(now, limit),
  );
}
