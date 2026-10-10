import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod";
import { cloudflareOperator, PACA_CLOUDFLARE_ACCOUNT } from "./lib/cloudflare-operator";
import { assertProductionConfiguration } from "./lib/production-config";

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function command(args: string[], input?: string) {
  const code = await new Promise<number | null>((success, failure) => {
    // Use Wrangler's Node runtime and verify actual remote state after CLI exit.
    const child = spawn(
      "node",
      [resolve(directory, "node_modules/wrangler/bin/wrangler.js"), ...args],
      {
        cwd: directory,
        stdio: ["pipe", "inherit", "inherit"],
        signal: AbortSignal.timeout(90_000),
      },
    );
    child.on("error", () => failure(Error("PRODUCTION_PROBE_COMMAND_FAILED")));
    child.on("exit", success);
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
  if (code !== 0) throw Error("PRODUCTION_PROBE_COMMAND_FAILED");
}

async function main() {
  const worker = JSON.parse(await readFile(resolve(directory, "wrangler.jsonc"), "utf8"));
  const gateway = JSON.parse(
    await readFile(resolve(directory, "../environment-gateway/wrangler.jsonc"), "utf8"),
  );
  assertProductionConfiguration(worker, gateway);
  const request = await cloudflareOperator();
  const scripts = z.array(z.object({ id: z.string() }));
  const deployed = scripts.parse(await request("/workers/scripts"));
  for (const name of ["paca-worker-api-internal", "paca-environment-gateway-internal"])
    if (!deployed.some((script) => script.id === name)) throw Error("PRODUCTION_WORKER_MISSING");
  const access = z.object({ enabled: z.literal(false), previews_enabled: z.literal(false) });
  access.parse(await request("/workers/scripts/paca-worker-api-internal/subdomain"));
  access.parse(await request("/workers/scripts/paca-environment-gateway-internal/subdomain"));
  const subdomain = z
    .object({ subdomain: z.string().regex(/^[a-z0-9-]{1,63}$/u) })
    .parse(await request("/workers/subdomain")).subdomain;
  const name = `paca-production-probe-${randomBytes(8).toString("hex")}`;
  if (deployed.some((script) => script.id === name)) throw Error("PRODUCTION_PROBE_NAME_CONFLICT");
  const temporary = await mkdtemp(join(tmpdir(), "paca-production-probe-"));
  const config = join(temporary, "wrangler.json");
  const probeToken = randomBytes(48).toString("hex");
  const healthToken = randomBytes(48).toString("hex");
  let attempted = false;
  try {
    // Configure only the private diagnostic token for this operator smoke.
    // Better Auth, GitHub and Gateway credentials are unchanged.
    await command(
      ["secret", "bulk", "--profile", "paca"],
      JSON.stringify({ INTERNAL_HEALTH_TOKEN: healthToken }),
    );
    await writeFile(
      config,
      JSON.stringify({
        name,
        account_id: PACA_CLOUDFLARE_ACCOUNT,
        main: resolve(directory, "scripts/lib/production-probe-worker.ts"),
        compatibility_date: worker.compatibility_date,
        workers_dev: true,
        preview_urls: false,
        routes: [],
        services: [
          { binding: "API", service: "paca-worker-api-internal" },
          { binding: "GATEWAY", service: "paca-environment-gateway-internal" },
        ],
        r2_buckets: [
          { binding: "ATTACHMENTS", bucket_name: "paca-attachments-internal" },
          { binding: "SNAPSHOTS", bucket_name: "paca-document-snapshots-internal" },
        ],
        vars: { PROBE_NAMESPACE: randomBytes(32).toString("hex") },
      }),
      { mode: 0o600, flag: "wx" },
    );
    const secretsFile = join(temporary, "secrets.json");
    await writeFile(
      secretsFile,
      JSON.stringify({ PROBE_TOKEN: probeToken, API_HEALTH_TOKEN: healthToken }),
      { mode: 0o600, flag: "wx" },
    );
    attempted = true;
    await command([
      "deploy",
      "--config",
      config,
      "--profile",
      "paca",
      "--secrets-file",
      secretsFile,
    ]);
    const url = `https://${name}.${subdomain}.workers.dev/verify`;
    const unauthorized = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    await unauthorized.body?.cancel();
    if (unauthorized.status !== 401) throw Error("PRODUCTION_PROBE_AUTH_FAILED");
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${probeToken}` },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (text.length > 4000) throw Error("PRODUCTION_PROBE_RESPONSE_TOO_LARGE");
    const result = z
      .object({
        status: z.literal("ok"),
        apiHealth: z.literal("verified"),
        gatewayHealth: z.literal("verified"),
        databaseHealth: z.literal("verified"),
        anonymousMe: z.literal(401),
        assets: z.literal("verified"),
        r2: z.literal("write_read_delete_verified"),
      })
      .parse(JSON.parse(text));
    if (!response.ok) throw Error("PRODUCTION_PROBE_FAILED");
    console.log(JSON.stringify(result));
  } finally {
    try {
      if (attempted && scripts.parse(await request("/workers/scripts")).some((s) => s.id === name))
        await command([
          "delete",
          "--config",
          config,
          "--name",
          name,
          "--force",
          "--profile",
          "paca",
        ]);
      await (async () => {
        if (scripts.parse(await request("/workers/scripts")).some((s) => s.id === name))
          throw Error("PRODUCTION_PROBE_CLEANUP_FAILED");
      })();
      console.log(JSON.stringify({ status: "ok", step: "temporary-production-probe-cleanup" }));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
main().catch(() => {
  console.error(JSON.stringify({ status: "failed", code: "PRODUCTION_SMOKE_FAILED" }));
  process.exitCode = 1;
});
