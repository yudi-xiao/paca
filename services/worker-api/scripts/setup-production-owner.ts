import { readdir } from "node:fs/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import * as z from "zod";
import * as schema from "../src/db/schema";
import { selectCleanSlateMigrationFiles } from "./lib/clean-slate-reset";
import { cloudflareOperator, deployedHyperdriveConsumers } from "./lib/cloudflare-operator";
import { startOwnerSetupPage } from "./lib/owner-setup-page";
import {
  assertUnpublishedProduction,
  productionDatabase,
  withProductionOperator,
} from "./lib/production-database";
import { createProductionOwner } from "./lib/production-owner";
import { verifyRuntimeRole } from "./lib/runtime-role";

async function setup(): Promise<void> {
  const email = z.email().max(254).parse(process.env.PACA_PRODUCTION_OWNER_EMAIL);
  const request = await cloudflareOperator();
  const consumers = await deployedHyperdriveConsumers(request, [
    productionDatabase.retiredHyperdrive,
    productionDatabase.productionHyperdrive,
  ]);
  const scripts = z.array(z.object({ id: z.string() })).parse(await request("/workers/scripts"));
  assertUnpublishedProduction(consumers, scripts);
  await withProductionOperator("owner", async (client) => {
    const expected = selectCleanSlateMigrationFiles(
      await readdir(new URL("../drizzle/", import.meta.url)),
    ).map((file) => file.replace(/\.sql$/u, ""));
    const ledger = await client.query<{ id: string }>(
      "select id from public.paca_schema_migration order by id",
    );
    if (JSON.stringify(ledger.rows.map((row) => row.id)) !== JSON.stringify(expected))
      throw new Error("PRODUCTION_OWNER_BASELINE_MISMATCH");
    await verifyRuntimeRole(client, productionDatabase.runtimeRole);
    const users = await client.query<{ count: number }>('select count(*)::int from public."user"');
    if (users.rows[0]?.count !== 0) throw new Error("PRODUCTION_OWNER_ALREADY_INITIALIZED");
    const db = drizzle(client, { schema });
    const page = await startOwnerSetupPage({
      email,
      createOwner: (input) => createProductionOwner(db, input),
    });
    const abort = () => {
      void page.close();
    };
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      console.log(
        JSON.stringify({
          status: "waiting-for-user",
          step: "production-owner-password",
          url: page.url,
          expiresInMinutes: 10,
        }),
      );
      const result = await page.finished;
      if (result !== "created") throw new Error("PRODUCTION_OWNER_SETUP_EXPIRED");
      console.log(
        JSON.stringify({
          status: "ok",
          step: "production-owner-created",
          bootstrapSessions: 0,
          published: false,
        }),
      );
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
      await page.close();
    }
  });
}

setup().catch(() => {
  console.error(JSON.stringify({ status: "error", code: "PRODUCTION_OWNER_SETUP_FAILED" }));
  process.exitCode = 1;
});
