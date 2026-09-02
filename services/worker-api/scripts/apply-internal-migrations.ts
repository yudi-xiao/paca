import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const expectedConfirmation = "APPLY_INTERNAL_MIGRATIONS";
const organization = process.env.PACA_PLANETSCALE_ORG?.trim();
const database = process.env.PACA_PLANETSCALE_DATABASE?.trim() || "paca";
const branch = process.env.PACA_PLANETSCALE_TARGET_BRANCH?.trim() || "internal";
const runtimeRoleName =
  process.env.PACA_PLANETSCALE_RUNTIME_ROLE_NAME?.trim() || "paca-worker-internal";
const postgresBin = process.env.PACA_POSTGRES_BIN?.trim();
const psql = postgresBin ? resolve(postgresBin, "psql") : "psql";
const workerDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrations = ["0019_volatile_hydra", "0020_pale_the_santerians", "0021_neat_dagger"] as const;

type RolePayload = {
  id?: unknown;
  username?: unknown;
  password?: unknown;
  database_url?: unknown;
};

type ListedRole = {
  name?: unknown;
  username?: unknown;
};

function redact(value: string): string {
  return value
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s/]+@/giu, "$1[REDACTED]@")
    .replace(/("password"\s*:\s*")[^"]+/giu, "$1[REDACTED]")
    .slice(0, 4_000);
}

async function run(
  executable: string,
  args: string[],
  options: { allowFailure?: boolean } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execFileAsync(executable, args, {
      cwd: workerDirectory,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    const result = {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      exitCode: typeof failure.code === "number" ? failure.code : 1,
    };
    if (options.allowFailure) return result;
    throw new Error(
      `${executable.toUpperCase()}_FAILED: ${redact(result.stderr || result.stdout || failure.message)}`,
    );
  }
}

async function pscale(args: string[]): Promise<string> {
  return (await run("pscale", [...args, "--org", organization ?? "", "--format", "json"])).stdout;
}

function parseRole(value: string): { id: string; databaseURL: string } {
  const role = JSON.parse(value) as RolePayload;
  if (typeof role.id !== "string" || typeof role.database_url !== "string") {
    throw new Error("TEMP_MIGRATION_ROLE_INVALID");
  }
  const url = new URL(role.database_url);
  if (!url.password && typeof role.password === "string") url.password = role.password;
  if (!url.password) throw new Error("TEMP_MIGRATION_ROLE_PASSWORD_MISSING");
  url.searchParams.set("sslmode", "verify-full");
  url.searchParams.set("sslrootcert", "system");
  return { id: role.id, databaseURL: url.toString() };
}

async function resolveRuntimeDatabaseRole(): Promise<string> {
  const roles = JSON.parse(await pscale(["role", "list", database, branch])) as unknown;
  if (!Array.isArray(roles)) throw new Error("RUNTIME_ROLE_LIST_INVALID");
  const role = roles.find(
    (candidate): candidate is ListedRole =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as ListedRole).name === runtimeRoleName,
  );
  if (!role || typeof role.username !== "string") throw new Error("RUNTIME_ROLE_NOT_FOUND");
  const databaseRole = role.username.split(".")[0]?.trim();
  if (!databaseRole || !/^pscale_api_[a-z0-9]+$/u.test(databaseRole)) {
    throw new Error("RUNTIME_DATABASE_ROLE_INVALID");
  }
  return databaseRole;
}

async function query(databaseURL: string, sql: string): Promise<string> {
  return (
    await run(psql, [
      "--dbname",
      databaseURL,
      "--no-psqlrc",
      "--tuples-only",
      "--no-align",
      "--set",
      "ON_ERROR_STOP=1",
      "--command",
      sql,
    ])
  ).stdout.trim();
}

async function psqlFile(
  databaseURL: string,
  path: string,
  variables: string[] = [],
): Promise<void> {
  const args = ["--dbname", databaseURL, "--no-psqlrc", "--set", "ON_ERROR_STOP=1"];
  for (const variable of variables) args.push("--set", variable);
  args.push("--file", resolve(workerDirectory, path));
  await run(psql, args);
}

async function main(): Promise<void> {
  if (process.env.PACA_APPLY_INTERNAL_CONFIRM !== expectedConfirmation) {
    throw new Error(`PACA_APPLY_INTERNAL_CONFIRM must equal ${expectedConfirmation}`);
  }
  if (!organization) throw new Error("PACA_PLANETSCALE_ORG_REQUIRED");
  if (branch !== "internal") throw new Error("TARGET_BRANCH_MUST_BE_INTERNAL");
  const runtimeDatabaseRole = await resolveRuntimeDatabaseRole();

  const role = parseRole(
    await pscale([
      "role",
      "create",
      database,
      branch,
      `paca-migrate-${Date.now()}`,
      "--inherited-roles",
      "postgres",
      "--ttl",
      "15m",
    ]),
  );
  let deleted = false;
  try {
    const applied = new Set(
      JSON.parse(
        await query(
          role.databaseURL,
          "SELECT COALESCE(json_agg(id ORDER BY applied_at, id)::text, '[]') FROM public.paca_schema_migration",
        ),
      ) as string[],
    );
    const pending = migrations.filter((migration) => !applied.has(migration));
    for (const migration of pending) {
      await psqlFile(role.databaseURL, `drizzle/${migration}.sql`);
    }
    await psqlFile(role.databaseURL, "scripts/sql/grant-runtime-role.sql", [
      `runtime_role=${runtimeDatabaseRole}`,
    ]);
    await psqlFile(role.databaseURL, "scripts/sql/verify-runtime-role.sql", [
      `runtime_role=${runtimeDatabaseRole}`,
    ]);
    const verified = JSON.parse(
      await query(
        role.databaseURL,
        `SELECT json_agg(id ORDER BY applied_at, id)::text FROM public.paca_schema_migration WHERE id = ANY (ARRAY['${migrations.join("','")}'])`,
      ),
    ) as string[];
    if (verified.length !== migrations.length)
      throw new Error("MIGRATION_LEDGER_VERIFICATION_FAILED");

    await pscale([
      "role",
      "reassign",
      database,
      branch,
      role.id,
      "--successor",
      "postgres",
      "--force",
    ]);
    await pscale(["role", "delete", database, branch, role.id, "--force"]);
    deleted = true;
    console.log(JSON.stringify({ status: "ok", database, branch, applied: verified }));
  } finally {
    if (!deleted) {
      await pscale([
        "role",
        "delete",
        database,
        branch,
        role.id,
        "--successor",
        "postgres",
        "--force",
      ]).catch(() => undefined);
    }
  }
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      status: "error",
      code: error instanceof Error ? redact(error.message) : "UNKNOWN_ERROR",
    }),
  );
  process.exitCode = 1;
});
