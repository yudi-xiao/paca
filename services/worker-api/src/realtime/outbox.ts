import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

import type { AppBindings } from "../bindings";
import { type PacaDatabase, withDatabase } from "../database";
import { pacaRealtimeOutbox } from "../db/schema";
import { parseRealtimeQueueMessage, type RealtimeQueueMessage } from "./queue-protocol";

const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 100;
const CLAIM_LEASE_MS = 60_000;
const ENQUEUED_RECOVERY_MS = 60 * 60_000;
const FAILURE_RETRY_MS = 15_000;

type OutboxRow = typeof pacaRealtimeOutbox.$inferSelect;

export type RealtimeOutboxDispatchResult = {
  claimed: number;
  enqueued: number;
  failed: number;
};

export type RealtimeOutboxRepository = {
  claim(now: Date, limit: number): Promise<OutboxRow[]>;
  markEnqueued(ids: string[], now: Date): Promise<void>;
  release(ids: string[], now: Date, failureCode: string): Promise<void>;
  markDelivered(id: string, now: Date): Promise<void>;
};

export class PostgresRealtimeOutboxRepository implements RealtimeOutboxRepository {
  constructor(private readonly database: PacaDatabase) {}

  async claim(now: Date, limit: number): Promise<OutboxRow[]> {
    const leaseExpiredBefore = new Date(now.getTime());
    const enqueuedBefore = new Date(now.getTime() - ENQUEUED_RECOVERY_MS);
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select()
        .from(pacaRealtimeOutbox)
        .where(
          or(
            and(eq(pacaRealtimeOutbox.status, "pending"), lte(pacaRealtimeOutbox.availableAt, now)),
            and(
              eq(pacaRealtimeOutbox.status, "enqueuing"),
              lte(pacaRealtimeOutbox.leaseExpiresAt, leaseExpiredBefore),
            ),
            and(
              eq(pacaRealtimeOutbox.status, "enqueued"),
              isNull(pacaRealtimeOutbox.deliveredAt),
              lte(pacaRealtimeOutbox.enqueuedAt, enqueuedBefore),
            ),
          ),
        )
        .orderBy(asc(pacaRealtimeOutbox.createdAt), asc(pacaRealtimeOutbox.id))
        .limit(limit)
        .for("update", { skipLocked: true });
      if (rows.length === 0) return [];

      const ids = rows.map((row) => row.id);
      const leaseExpiresAt = new Date(now.getTime() + CLAIM_LEASE_MS);
      await transaction
        .update(pacaRealtimeOutbox)
        .set({
          status: "enqueuing",
          attempts: sql`${pacaRealtimeOutbox.attempts} + 1`,
          leaseExpiresAt,
          failureCode: null,
          updatedAt: now,
        })
        .where(inArray(pacaRealtimeOutbox.id, ids));

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
      .update(pacaRealtimeOutbox)
      .set({
        status: "enqueued",
        enqueuedAt: now,
        leaseExpiresAt: null,
        failureCode: null,
        updatedAt: now,
      })
      .where(inArray(pacaRealtimeOutbox.id, ids));
  }

  async release(ids: string[], now: Date, failureCode: string): Promise<void> {
    if (ids.length === 0) return;
    await this.database
      .update(pacaRealtimeOutbox)
      .set({
        status: "pending",
        availableAt: new Date(now.getTime() + FAILURE_RETRY_MS),
        leaseExpiresAt: null,
        failureCode,
        updatedAt: now,
      })
      .where(inArray(pacaRealtimeOutbox.id, ids));
  }

  async markDelivered(id: string, now: Date): Promise<void> {
    const [row] = await this.database
      .update(pacaRealtimeOutbox)
      .set({
        status: "delivered",
        deliveredAt: now,
        leaseExpiresAt: null,
        failureCode: null,
        updatedAt: now,
      })
      .where(eq(pacaRealtimeOutbox.id, id))
      .returning({ id: pacaRealtimeOutbox.id });
    if (!row) throw new Error("REALTIME_OUTBOX_NOT_FOUND");
  }
}

function outboxMessage(row: OutboxRow): RealtimeQueueMessage {
  return parseRealtimeQueueMessage({
    version: 1,
    outboxId: row.id,
    roomType: row.roomType,
    roomId: row.roomId,
    event: { type: row.eventType, payload: row.payload },
    createdAt: row.createdAt.toISOString(),
  });
}

function failureCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message)) return error.message;
  return "REALTIME_QUEUE_SEND_FAILED";
}

export async function dispatchRealtimeOutbox(
  env: AppBindings,
  options: {
    now?: Date;
    limit?: number;
    repository?: RealtimeOutboxRepository;
    queue?: Pick<Queue<RealtimeQueueMessage>, "sendBatch">;
  } = {},
): Promise<RealtimeOutboxDispatchResult> {
  const now = options.now ?? new Date();
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_BATCH_SIZE, 1), MAX_BATCH_SIZE);
  const run = async (repository: RealtimeOutboxRepository) => {
    const rows = await repository.claim(now, limit);
    if (rows.length === 0) return { claimed: 0, enqueued: 0, failed: 0 };
    const ids = rows.map((row) => row.id);
    try {
      await (options.queue ?? env.REALTIME_EVENTS).sendBatch(
        rows.map((row) => ({ body: outboxMessage(row), contentType: "json" as const })),
      );
      await repository.markEnqueued(ids, now);
      return { claimed: rows.length, enqueued: rows.length, failed: 0 };
    } catch (error) {
      await repository.release(ids, now, failureCode(error));
      return { claimed: rows.length, enqueued: 0, failed: rows.length };
    }
  };

  if (options.repository) return run(options.repository);
  return withDatabase(env, (database) => run(new PostgresRealtimeOutboxRepository(database)));
}
