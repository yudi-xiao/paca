import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import type { AppBindings } from "./bindings";
import * as schema from "./db/schema";

export type PacaDatabase = NodePgDatabase<typeof schema>;

export type DatabaseHealth = {
  latencyMs: number;
};

export async function withDatabase<T>(
  env: AppBindings,
  operation: (db: PacaDatabase) => Promise<T>,
): Promise<T> {
  const client = new Client({
    connectionString: env.HYPERDRIVE.connectionString,
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
    statement_timeout: 5_000,
  });

  try {
    await client.connect();
    const db = drizzle(client, { schema });
    return await operation(db);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function checkDatabaseHealth(env: AppBindings): Promise<DatabaseHealth> {
  const startedAt = performance.now();

  return withDatabase(env, async (db) => {
    await db.execute(
      sql`select current_database() as database_name, current_schema() as schema_name`,
    );

    return {
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
  });
}
