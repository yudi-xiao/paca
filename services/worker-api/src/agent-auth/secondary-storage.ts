import type { BetterAuthOptions } from "better-auth";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";

import type { PacaDatabase } from "../database";
import { pacaAuthSecondaryStorage } from "../db/schema";

type SecondaryStorage = NonNullable<BetterAuthOptions["secondaryStorage"]>;
const JTI_KEY_PREFIX = "agent-auth:jti:";

export class AgentReplayDetectedError extends Error {
  constructor() {
    super("AGENT_JWT_REPLAYED");
    this.name = "AgentReplayDetectedError";
  }
}

export class PostgresBetterAuthSecondaryStorage implements SecondaryStorage {
  constructor(private readonly database: PacaDatabase) {}

  async get(key: string): Promise<string | null> {
    const [row] = await this.database
      .select({ value: pacaAuthSecondaryStorage.value })
      .from(pacaAuthSecondaryStorage)
      .where(
        and(
          eq(pacaAuthSecondaryStorage.key, key),
          or(
            isNull(pacaAuthSecondaryStorage.expiresAt),
            gt(pacaAuthSecondaryStorage.expiresAt, new Date()),
          ),
        ),
      )
      .limit(1);
    return row?.value ?? null;
  }

  async getAndDelete(key: string): Promise<string | null> {
    const result = await this.database.execute<{ value: string }>(sql`
      delete from ${pacaAuthSecondaryStorage}
      where ${pacaAuthSecondaryStorage.key} = ${key}
        and (
          ${pacaAuthSecondaryStorage.expiresAt} is null
          or ${pacaAuthSecondaryStorage.expiresAt} > now()
        )
      returning ${pacaAuthSecondaryStorage.value}
    `);
    return result.rows[0]?.value ?? null;
  }

  async increment(key: string, ttl: number): Promise<number> {
    const expiresAt = new Date(Date.now() + Math.max(1, ttl) * 1_000);
    const result = await this.database.execute<{ value: string }>(sql`
      insert into ${pacaAuthSecondaryStorage} (
        ${pacaAuthSecondaryStorage.key},
        ${pacaAuthSecondaryStorage.value},
        ${pacaAuthSecondaryStorage.expiresAt}
      ) values (${key}, '1', ${expiresAt})
      on conflict (${pacaAuthSecondaryStorage.key}) do update set
        ${pacaAuthSecondaryStorage.value} = case
          when ${pacaAuthSecondaryStorage.expiresAt} is not null
            and ${pacaAuthSecondaryStorage.expiresAt} <= now()
          then '1'
          else ((${pacaAuthSecondaryStorage.value})::bigint + 1)::text
        end,
        ${pacaAuthSecondaryStorage.expiresAt} = case
          when ${pacaAuthSecondaryStorage.expiresAt} is not null
            and ${pacaAuthSecondaryStorage.expiresAt} <= now()
          then excluded.${sql.identifier("expires_at")}
          else ${pacaAuthSecondaryStorage.expiresAt}
        end,
        ${pacaAuthSecondaryStorage.updatedAt} = now()
      returning ${pacaAuthSecondaryStorage.value}
    `);
    const value = Number(result.rows[0]?.value);
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error("SECONDARY_STORAGE_INVALID_COUNT");
    return value;
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    const expiresAt = ttl === undefined ? null : new Date(Date.now() + Math.max(1, ttl) * 1_000);

    if (key.startsWith(JTI_KEY_PREFIX)) {
      const inserted = await this.database
        .insert(pacaAuthSecondaryStorage)
        .values({ key, value, expiresAt })
        .onConflictDoNothing()
        .returning({ key: pacaAuthSecondaryStorage.key });
      if (inserted.length === 0) throw new AgentReplayDetectedError();
      return;
    }

    await this.database
      .insert(pacaAuthSecondaryStorage)
      .values({ key, value, expiresAt })
      .onConflictDoUpdate({
        target: pacaAuthSecondaryStorage.key,
        set: { value, expiresAt, updatedAt: new Date() },
      });
  }

  async delete(key: string): Promise<void> {
    await this.database
      .delete(pacaAuthSecondaryStorage)
      .where(eq(pacaAuthSecondaryStorage.key, key));
  }
}
