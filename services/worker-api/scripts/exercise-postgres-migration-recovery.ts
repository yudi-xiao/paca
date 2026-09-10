import { Client } from "pg";

import { requireLocalTestDatabase } from "./lib/postgres-test-database";

const { connectionString, databaseName } = requireLocalTestDatabase();
const probeTable = "paca_migration_recovery_probe";
const client = new Client({
  connectionString,
  connectionTimeoutMillis: 5_000,
  query_timeout: 10_000,
  statement_timeout: 10_000,
});
let connected = false;

async function tableExists(): Promise<boolean> {
  const result = await client.query<{ relation: string | null }>(
    "select to_regclass($1) as relation",
    [`public.${probeTable}`],
  );
  return result.rows[0]?.relation === probeTable;
}

try {
  await client.connect();
  connected = true;
  const identity = await client.query<{ database_name: string }>(
    "select current_database() as database_name",
  );
  if (identity.rows[0]?.database_name !== databaseName) {
    throw new Error("PACA_TEST_DATABASE_IDENTITY_MISMATCH");
  }
  if (await tableExists()) throw new Error("PACA_MIGRATION_RECOVERY_PROBE_ALREADY_EXISTS");

  let failedAsExpected = false;
  try {
    await client.query(`
      begin;
      create table ${probeTable} (id integer primary key);
      insert into ${probeTable} (id) values (1), (1);
      commit;
    `);
  } catch {
    failedAsExpected = true;
    await client.query("rollback").catch(() => undefined);
  }
  if (!failedAsExpected) throw new Error("PACA_MIGRATION_FAILURE_NOT_OBSERVED");
  if (await tableExists()) throw new Error("PACA_MIGRATION_ROLLBACK_INCOMPLETE");

  await client.query(`
    begin;
    create table ${probeTable} (
      id integer primary key,
      legacy_value text not null
    );
    insert into ${probeTable} (id, legacy_value) values (1, 'paca');
    commit;
  `);

  await client.query(`
    begin;
    alter table ${probeTable} add column normalized_value text;
    update ${probeTable} set normalized_value = upper(trim(legacy_value));
    alter table ${probeTable} alter column normalized_value set not null;
    commit;
  `);

  const repaired = await client.query<{
    id: number;
    legacy_value: string;
    normalized_value: string;
  }>(`select id, legacy_value, normalized_value from ${probeTable}`);
  if (
    repaired.rows.length !== 1 ||
    repaired.rows[0]?.id !== 1 ||
    repaired.rows[0].legacy_value !== "paca" ||
    repaired.rows[0].normalized_value !== "PACA"
  ) {
    throw new Error("PACA_MIGRATION_FORWARD_FIX_INVALID");
  }

  console.log(
    JSON.stringify({
      status: "ok",
      step: "postgres-migration-recovery-exercised",
      database: databaseName,
      transactionalRollback: true,
      forwardFixPreservedRows: repaired.rows.length,
    }),
  );
} finally {
  if (connected) {
    await client.query(`drop table if exists ${probeTable}`).catch(() => undefined);
  }
  await client.end().catch(() => undefined);
}
