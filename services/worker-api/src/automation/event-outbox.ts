import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import * as z from "zod";

import type { AppBindings } from "../bindings";
import { type PacaDatabase, withDatabase } from "../database";
import { pacaAutomationEventOutbox } from "../db/schema";

const CLAIM_LEASE_MS = 60_000;
const ENQUEUED_RECOVERY_MS = 60 * 60_000;
const FAILURE_RETRY_MS = 15_000;

const messageSchema = z.object({ version: z.literal(1), outboxId: z.uuid() }).strict();

export type AutomationQueueMessage = z.infer<typeof messageSchema>;
export type AutomationEventRow = typeof pacaAutomationEventOutbox.$inferSelect;

export function parseAutomationQueueMessage(value: unknown): AutomationQueueMessage {
  return messageSchema.parse(value);
}

export type AutomationOutboxRepository = {
  claim(now: Date, limit: number): Promise<AutomationEventRow[]>;
  markEnqueued(ids: string[], now: Date): Promise<void>;
  release(ids: string[], now: Date, failureCode: string): Promise<void>;
  get(id: string): Promise<AutomationEventRow | null>;
  markDelivered(id: string, now: Date): Promise<void>;
};

export class PostgresAutomationOutboxRepository implements AutomationOutboxRepository {
  constructor(private readonly database: PacaDatabase) {}

  async claim(now: Date, limit: number): Promise<AutomationEventRow[]> {
    const enqueuedBefore = new Date(now.getTime() - ENQUEUED_RECOVERY_MS);
    return this.database.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(pacaAutomationEventOutbox)
        .where(
          or(
            and(
              eq(pacaAutomationEventOutbox.status, "pending"),
              lte(pacaAutomationEventOutbox.availableAt, now),
            ),
            and(
              eq(pacaAutomationEventOutbox.status, "enqueuing"),
              lte(pacaAutomationEventOutbox.leaseExpiresAt, now),
            ),
            and(
              eq(pacaAutomationEventOutbox.status, "enqueued"),
              isNull(pacaAutomationEventOutbox.deliveredAt),
              lte(pacaAutomationEventOutbox.enqueuedAt, enqueuedBefore),
            ),
          ),
        )
        .orderBy(asc(pacaAutomationEventOutbox.createdAt), asc(pacaAutomationEventOutbox.id))
        .limit(limit)
        .for("update", { skipLocked: true });
      if (rows.length === 0) return [];
      const ids = rows.map((row) => row.id);
      const leaseExpiresAt = new Date(now.getTime() + CLAIM_LEASE_MS);
      await tx
        .update(pacaAutomationEventOutbox)
        .set({
          status: "enqueuing",
          attempts: sql`${pacaAutomationEventOutbox.attempts} + 1`,
          leaseExpiresAt,
          failureCode: null,
          updatedAt: now,
        })
        .where(inArray(pacaAutomationEventOutbox.id, ids));
      return rows.map((row) => ({
        ...row,
        status: "enqueuing" as const,
        attempts: row.attempts + 1,
        leaseExpiresAt,
        failureCode: null,
        updatedAt: now,
      }));
    });
  }

  async markEnqueued(ids: string[], now: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.database
      .update(pacaAutomationEventOutbox)
      .set({
        status: "enqueued",
        enqueuedAt: now,
        leaseExpiresAt: null,
        failureCode: null,
        updatedAt: now,
      })
      .where(inArray(pacaAutomationEventOutbox.id, ids));
  }

  async release(ids: string[], now: Date, failureCode: string): Promise<void> {
    if (ids.length === 0) return;
    await this.database
      .update(pacaAutomationEventOutbox)
      .set({
        status: "pending",
        availableAt: new Date(now.getTime() + FAILURE_RETRY_MS),
        leaseExpiresAt: null,
        failureCode,
        updatedAt: now,
      })
      .where(inArray(pacaAutomationEventOutbox.id, ids));
  }

  async get(id: string): Promise<AutomationEventRow | null> {
    const [row] = await this.database
      .select()
      .from(pacaAutomationEventOutbox)
      .where(eq(pacaAutomationEventOutbox.id, id));
    return row ?? null;
  }

  async markDelivered(id: string, now: Date): Promise<void> {
    await this.database
      .update(pacaAutomationEventOutbox)
      .set({
        status: "delivered",
        deliveredAt: now,
        leaseExpiresAt: null,
        failureCode: null,
        updatedAt: now,
      })
      .where(eq(pacaAutomationEventOutbox.id, id));
  }
}

function safeFailureCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_]{1,100}$/u.test(error.message)) return error.message;
  return "AUTOMATION_QUEUE_SEND_FAILED";
}

export async function dispatchAutomationOutbox(
  env: AppBindings,
  options: {
    now?: Date;
    limit?: number;
    repository?: AutomationOutboxRepository;
    queue?: Pick<Queue<AutomationQueueMessage>, "sendBatch">;
  } = {},
): Promise<{ claimed: number; enqueued: number; failed: number }> {
  const now = options.now ?? new Date();
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 100);
  const dispatch = async (repository: AutomationOutboxRepository) => {
    const rows = await repository.claim(now, limit);
    if (rows.length === 0) return { claimed: 0, enqueued: 0, failed: 0 };
    const ids = rows.map((row) => row.id);
    try {
      await (options.queue ?? env.AUTOMATION_EVENTS).sendBatch(
        rows.map((row) => ({
          body: { version: 1 as const, outboxId: row.id },
          contentType: "json" as const,
        })),
      );
      await repository.markEnqueued(ids, now);
      return { claimed: rows.length, enqueued: rows.length, failed: 0 };
    } catch (error) {
      await repository.release(ids, now, safeFailureCode(error));
      return { claimed: rows.length, enqueued: 0, failed: rows.length };
    }
  };
  if (options.repository) return dispatch(options.repository);
  return withDatabase(env, (database) =>
    dispatch(new PostgresAutomationOutboxRepository(database)),
  );
}
