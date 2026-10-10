import { readdir, readFile } from "node:fs/promises";
import * as z from "zod";
import {
  buildCleanSlateSchemaResetSQL,
  selectCleanSlateMigrationFiles,
} from "./lib/clean-slate-reset";
import { cloudflareOperator, deployedHyperdriveConsumers } from "./lib/cloudflare-operator";
import { assertProductionConfiguration } from "./lib/production-config";
import {
  assertRecentProductionBackup,
  assertUnpublishedProduction,
  productionCommand,
  productionDatabase,
  withProductionOperator,
} from "./lib/production-database";
import { grantRuntimeRole, verifyRuntimeRole } from "./lib/runtime-role";

async function initialize(): Promise<void> {
  if (process.env.PACA_INITIALIZE_PRODUCTION !== "INITIALIZE_UNPUBLISHED_PACA_MAIN")
    throw new Error("PRODUCTION_INITIALIZATION_CONFIRMATION_REQUIRED");
  const backupId = process.env.PACA_PRODUCTION_BACKUP_ID;
  if (!backupId || !/^[a-z0-9]+$/u.test(backupId)) throw new Error("PRODUCTION_BACKUP_ID_REQUIRED");
  const worker = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  const gateway = JSON.parse(
    await readFile(new URL("../../environment-gateway/wrangler.jsonc", import.meta.url), "utf8"),
  );
  assertProductionConfiguration(worker, gateway, "candidate");
  assertRecentProductionBackup(
    await productionCommand(["backup", "show", "paca", "main", backupId]),
  );
  const request = await cloudflareOperator();
  const consumers = await deployedHyperdriveConsumers(request, [
    productionDatabase.retiredHyperdrive,
    productionDatabase.productionHyperdrive,
  ]);
  const scripts = z.array(z.object({ id: z.string() })).parse(await request("/workers/scripts"));
  assertUnpublishedProduction(consumers, scripts);
  const roles = z
    .array(
      z.object({ id: z.string().regex(/^[a-z0-9]+$/u), name: z.string(), username: z.string() }),
    )
    .parse(await productionCommand(["role", "list", "paca", "main"]));
  const runtime = roles.find((role) => role.name === productionDatabase.runtimeRoleName);
  if (runtime?.username !== `${productionDatabase.runtimeRole}.${productionDatabase.branchId}`)
    throw new Error("PRODUCTION_RUNTIME_ROLE_MISMATCH");
  const retired = roles.filter(
    (role) => role.username === `pscale_api_hsj32h06q6xe.${productionDatabase.branchId}`,
  );
  if (retired.length > 1) throw new Error("RETIRED_ROLE_AMBIGUOUS");
  const migrationsDirectory = new URL("../drizzle/", import.meta.url);
  const migrationFiles = selectCleanSlateMigrationFiles(await readdir(migrationsDirectory));
  await withProductionOperator("initialize", async (client, role) => {
    // A current baseline (even empty) must not be reset again. This tool is
    // exclusively for the known unpublished legacy main branch.
    await client.query("BEGIN");
    try {
      // Share the canonical owner provisioner's transaction lock, then inspect
      // the baseline. Two operators cannot both pass a stale pre-reset check.
      await client.query("select pg_advisory_xact_lock(1885432671)");
      const ledger = await client.query<{ id: string }>(
        "select id from public.paca_schema_migration order by id",
      );
      const expectedLegacy = migrationFiles.slice(0, 15).map((file) => file.replace(/\.sql$/u, ""));
      if (JSON.stringify(ledger.rows.map((row) => row.id)) !== JSON.stringify(expectedLegacy))
        throw new Error("PRODUCTION_LEGACY_BASELINE_MISMATCH");
      for (const obsolete of retired)
        await productionCommand([
          "role",
          "delete",
          "paca",
          "main",
          obsolete.id,
          "--successor",
          "postgres",
          "--force",
        ]);
      await client.query(buildCleanSlateSchemaResetSQL(role));
      for (const file of migrationFiles) {
        const source = await readFile(new URL(file, migrationsDirectory), "utf8");
        const sql =
          /^\s*BEGIN;/iu.test(source) && /COMMIT;\s*$/iu.test(source)
            ? source.replace(/^\s*BEGIN;/iu, "").replace(/COMMIT;\s*$/iu, "")
            : source;
        await client.query(sql);
      }
      const applied = await client.query<{ id: string }>(
        "select id from public.paca_schema_migration order by id",
      );
      if (
        JSON.stringify(applied.rows.map((row) => row.id)) !==
        JSON.stringify(migrationFiles.map((file) => file.replace(/\.sql$/u, "")))
      )
        throw new Error("PRODUCTION_MIGRATION_LEDGER_MISMATCH");
      await grantRuntimeRole(client, productionDatabase.runtimeRole);
      await verifyRuntimeRole(client, productionDatabase.runtimeRole);
      const identities = await client.query<{ users: number }>(
        'select count(*)::int as users from public."user"',
      );
      if (identities.rows[0]?.users !== 0) throw new Error("PRODUCTION_CLEAN_SLATE_NOT_EMPTY");
      await client.query("COMMIT");
    } catch {
      await client.query("ROLLBACK");
      throw new Error("PRODUCTION_INITIALIZATION_ROLLED_BACK");
    }
  });
  console.log(
    JSON.stringify({
      status: "ok",
      step: "production-database-initialized",
      branch: "main",
      migrations: migrationFiles.length,
      runtimeGrantsApplied: true,
      backupId,
      published: false,
    }),
  );
}

initialize().catch(() => {
  console.error(
    JSON.stringify({ status: "error", code: "PRODUCTION_DATABASE_INITIALIZATION_FAILED" }),
  );
  process.exitCode = 1;
});
