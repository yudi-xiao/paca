import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  buildCleanSlateSchemaResetSQL,
  type CleanSlateResetConfiguration,
  parseCleanSlateResetConfiguration,
  selectCleanSlateMigrationFiles,
} from "./lib/clean-slate-reset";

const execFileAsync = promisify(execFile);
const postgresBin = process.env.PACA_POSTGRES_BIN?.trim();
const psql = postgresBin ? resolve(postgresBin, "psql") : "psql";
const workerDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDirectory = resolve(workerDirectory, "drizzle");
const internalWorkerOrigin = "https://paca.howlearnwood.com";

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

async function pscale(
  configuration: CleanSlateResetConfiguration,
  args: string[],
): Promise<string> {
  return (await run("pscale", [...args, "--org", configuration.organization, "--format", "json"]))
    .stdout;
}

function parseRole(value: string): { id: string; databaseURL: string; databaseRole: string } {
  const role = JSON.parse(value) as RolePayload;
  if (typeof role.id !== "string" || typeof role.database_url !== "string") {
    throw new Error("TEMP_MIGRATION_ROLE_INVALID");
  }
  const url = new URL(role.database_url);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("TEMP_MIGRATION_ROLE_URL_INVALID");
  }
  if (!url.password && typeof role.password === "string") url.password = role.password;
  if (!url.password) throw new Error("TEMP_MIGRATION_ROLE_PASSWORD_MISSING");
  const databaseRole = url.username.split(".")[0]?.trim();
  if (!databaseRole || !/^pscale_api_[a-z0-9]+$/u.test(databaseRole)) {
    throw new Error("TEMP_MIGRATION_DATABASE_ROLE_INVALID");
  }
  url.searchParams.set("sslmode", "verify-full");
  url.searchParams.set("sslrootcert", "system");
  return { id: role.id, databaseURL: url.toString(), databaseRole };
}

async function resolveRuntimeDatabaseRole(
  configuration: CleanSlateResetConfiguration,
): Promise<string> {
  const roles = JSON.parse(
    await pscale(configuration, ["role", "list", configuration.database, configuration.branch]),
  ) as unknown;
  if (!Array.isArray(roles)) throw new Error("RUNTIME_ROLE_LIST_INVALID");
  const role = roles.find(
    (candidate): candidate is ListedRole =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as ListedRole).name === configuration.runtimeRoleName,
  );
  if (!role || typeof role.username !== "string") throw new Error("RUNTIME_ROLE_NOT_FOUND");
  const databaseRole = role.username.split(".")[0]?.trim();
  if (!databaseRole || !/^pscale_api_[a-z0-9]+$/u.test(databaseRole)) {
    throw new Error("RUNTIME_DATABASE_ROLE_INVALID");
  }
  return databaseRole;
}

async function roleExists(
  configuration: CleanSlateResetConfiguration,
  roleId: string,
): Promise<boolean> {
  const roles = JSON.parse(
    await pscale(configuration, ["role", "list", configuration.database, configuration.branch]),
  ) as unknown;
  if (!Array.isArray(roles)) throw new Error("TEMP_ROLE_LIST_INVALID");
  return roles.some(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      "id" in candidate &&
      candidate.id === roleId,
  );
}

async function retireTemporaryRole(
  configuration: CleanSlateResetConfiguration,
  roleId: string,
): Promise<void> {
  try {
    await pscale(configuration, [
      "role",
      "reassign",
      configuration.database,
      configuration.branch,
      roleId,
      "--successor",
      "postgres",
      "--force",
    ]);
  } catch (error) {
    if (!(await roleExists(configuration, roleId))) return;
    throw error;
  }

  try {
    await pscale(configuration, [
      "role",
      "delete",
      configuration.database,
      configuration.branch,
      roleId,
      "--force",
    ]);
  } catch (error) {
    if (!(await roleExists(configuration, roleId))) return;
    throw error;
  }
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
  options: { singleTransaction?: boolean; variables?: string[] } = {},
): Promise<void> {
  const args = ["--dbname", databaseURL, "--no-psqlrc", "--set", "ON_ERROR_STOP=1"];
  if (options.singleTransaction) args.push("--single-transaction");
  for (const variable of options.variables ?? []) args.push("--set", variable);
  args.push("--file", resolve(workerDirectory, path));
  await run(psql, args);
}

async function verifyWorkerAfterReset(databaseURL: string): Promise<void> {
  const email = `reset-smoke-${crypto.randomUUID()}@paca.invalid`;
  const password = `Paca-${crypto.randomUUID()}-Aa1!`;
  let created = false;
  try {
    const signUp = await fetch(`${internalWorkerOrigin}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: internalWorkerOrigin },
      body: JSON.stringify({ email, password, name: "Paca Reset Smoke" }),
      redirect: "manual",
    });
    if (!signUp.ok) throw new Error(`RESET_EDGE_SIGN_UP_FAILED:${signUp.status}`);
    created = true;
    const cookie = signUp.headers.get("set-cookie")?.split(";", 1)[0];
    if (!cookie) throw new Error("RESET_EDGE_SESSION_COOKIE_MISSING");

    const currentUser = await fetch(`${internalWorkerOrigin}/api/me`, {
      headers: { cookie, origin: internalWorkerOrigin },
      redirect: "manual",
    });
    if (!currentUser.ok) throw new Error(`RESET_EDGE_CURRENT_USER_FAILED:${currentUser.status}`);
    const payload = (await currentUser.json()) as { data?: { user?: { email?: unknown } } };
    if (payload.data?.user?.email !== email) throw new Error("RESET_EDGE_CURRENT_USER_MISMATCH");
  } finally {
    if (created) {
      await query(databaseURL, `delete from public."user" where email = '${email}'`);
    }
  }

  const remainingUsers = Number(await query(databaseURL, 'select count(*) from public."user"'));
  if (remainingUsers !== 0) throw new Error("RESET_EDGE_CLEANUP_FAILED");
}

async function main(): Promise<void> {
  const configuration = parseCleanSlateResetConfiguration(process.env);
  const migrationFiles = selectCleanSlateMigrationFiles(await readdir(migrationsDirectory));
  const expectedLedger = migrationFiles.map((name) => name.replace(/\.sql$/u, ""));
  const runtimeDatabaseRole = await resolveRuntimeDatabaseRole(configuration);

  const role = parseRole(
    await pscale(configuration, [
      "role",
      "create",
      configuration.database,
      configuration.branch,
      `paca-reset-${Date.now()}`,
      "--inherited-roles",
      "postgres",
      "--ttl",
      "15m",
    ]),
  );
  let deleted = false;
  let resetFailure: unknown;
  let successPayload: Record<string, unknown> | undefined;
  try {
    const currentUser = await query(role.databaseURL, "select current_user");
    if (currentUser !== role.databaseRole) throw new Error("RESET_DATABASE_IDENTITY_MISMATCH");

    await query(role.databaseURL, buildCleanSlateSchemaResetSQL(role.databaseRole));
    for (const [index, migrationFile] of migrationFiles.entries()) {
      await psqlFile(role.databaseURL, `drizzle/${migrationFile}`, {
        singleTransaction: index === 0,
      });
    }

    await psqlFile(role.databaseURL, "scripts/sql/grant-runtime-role.sql", {
      variables: [`runtime_role=${runtimeDatabaseRole}`],
    });
    await psqlFile(role.databaseURL, "scripts/sql/verify-runtime-role.sql", {
      variables: [`runtime_role=${runtimeDatabaseRole}`],
    });

    const actualLedger = JSON.parse(
      await query(
        role.databaseURL,
        "select coalesce(json_agg(id order by id)::text, '[]') from public.paca_schema_migration",
      ),
    ) as string[];
    if (JSON.stringify(actualLedger) !== JSON.stringify(expectedLedger)) {
      throw new Error("RESET_MIGRATION_LEDGER_MISMATCH");
    }
    const userCount = Number(await query(role.databaseURL, 'select count(*) from public."user"'));
    if (userCount !== 0) throw new Error("RESET_BOOTSTRAP_USER_COUNT_INVALID");
    await verifyWorkerAfterReset(role.databaseURL);

    await retireTemporaryRole(configuration, role.id);
    deleted = true;
    successPayload = {
      status: "ok",
      database: configuration.database,
      branch: configuration.branch,
      migrations: actualLedger.length,
      users: userCount,
      edgeVerified: true,
    };
  } catch (error) {
    resetFailure = error;
  }

  if (!deleted) {
    try {
      await retireTemporaryRole(configuration, role.id);
    } catch (cleanupError) {
      throw new Error(
        `RESET_FAILED: ${errorMessage(resetFailure)}; TEMP_ROLE_CLEANUP_FAILED: ${errorMessage(cleanupError)}`,
      );
    }
  }

  if (resetFailure) throw resetFailure;
  console.log(JSON.stringify(successPayload));
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
