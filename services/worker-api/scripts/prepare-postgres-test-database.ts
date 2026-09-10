import { readdir, readFile } from "node:fs/promises";

import { Client } from "pg";

const databaseURL = process.env.PACA_TEST_DATABASE_URL?.trim();
if (!databaseURL) throw new Error("PACA_TEST_DATABASE_URL_REQUIRED");

const parsedURL = new URL(databaseURL);
if (!/^postgres(?:ql)?:$/u.test(parsedURL.protocol)) {
  throw new Error("PACA_TEST_DATABASE_URL_INVALID");
}

const databaseName = decodeURIComponent(parsedURL.pathname.slice(1));
if (!/^[a-z0-9_]+_test$/u.test(databaseName)) {
  throw new Error("PACA_TEST_DATABASE_NAME_MUST_END_IN_TEST");
}

const localHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
if (!localHosts.has(parsedURL.hostname)) {
  throw new Error("PACA_TEST_DATABASE_MUST_BE_LOCAL");
}

const migrationsDirectory = new URL("../drizzle/", import.meta.url);
const migrationFiles = (await readdir(migrationsDirectory))
  .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
  .sort((left, right) => left.localeCompare(right));
if (migrationFiles.length === 0) throw new Error("PACA_TEST_MIGRATIONS_MISSING");

const client = new Client({
  connectionString: databaseURL,
  connectionTimeoutMillis: 5_000,
  query_timeout: 30_000,
  statement_timeout: 30_000,
});

try {
  await client.connect();
  const identity = await client.query<{ database_name: string }>(
    "select current_database() as database_name",
  );
  if (identity.rows[0]?.database_name !== databaseName) {
    throw new Error("PACA_TEST_DATABASE_IDENTITY_MISMATCH");
  }

  await client.query("drop schema public cascade; create schema public");

  for (const migrationFile of migrationFiles) {
    const migration = await readFile(new URL(migrationFile, migrationsDirectory), "utf8");
    const isTransactional = /^\s*BEGIN;/iu.test(migration) && /COMMIT;\s*$/iu.test(migration);
    try {
      await client.query(isTransactional ? migration : `BEGIN;\n${migration}\nCOMMIT;`);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      const code =
        error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : "UNKNOWN";
      throw new Error(`PACA_TEST_MIGRATION_FAILED:${migrationFile}:${code}`);
    }
  }

  const ledger = await client.query<{ id: string }>(
    "select id from paca_schema_migration order by id",
  );
  const expected = migrationFiles.map((name) => name.replace(/\.sql$/u, ""));
  const actual = ledger.rows.map((row) => row.id);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("PACA_TEST_MIGRATION_LEDGER_MISMATCH");
  }

  console.log(
    JSON.stringify({
      status: "ok",
      step: "postgres-test-database-prepared",
      database: databaseName,
      migrations: actual.length,
    }),
  );
} finally {
  await client.end().catch(() => undefined);
}
