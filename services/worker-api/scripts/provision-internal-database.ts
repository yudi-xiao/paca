import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const confirmation = "PROVISION_INTERNAL_DATABASE";
const organization = process.env.PACA_PLANETSCALE_ORG?.trim();
const database = process.env.PACA_PLANETSCALE_DATABASE?.trim() || "paca";
const sourceBranch = process.env.PACA_PLANETSCALE_SOURCE_BRANCH?.trim() || "main";
const targetBranch = process.env.PACA_PLANETSCALE_TARGET_BRANCH?.trim() || "internal";
const runtimeRoleID = process.env.PACA_PLANETSCALE_RUNTIME_ROLE_ID?.trim();
const hyperdriveName = process.env.PACA_HYPERDRIVE_NAME?.trim() || "paca-internal";
const postgresBin = process.env.PACA_POSTGRES_BIN?.trim();
const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const workerDirectory = resolve(scriptsDirectory, "..");
const grantSQL = resolve(scriptsDirectory, "sql/grant-runtime-role.sql");
const verifySQL = resolve(scriptsDirectory, "sql/verify-runtime-role.sql");
const psql = postgresBin ? resolve(postgresBin, "psql") : "psql";
const pgDump = postgresBin ? resolve(postgresBin, "pg_dump") : "pg_dump";

const applicationTables = [
  "user",
  "session",
  "account",
  "verification",
  "organization",
  "member",
  "invitation",
  "agent_host",
  "agent",
  "agent_capability_grant",
  "approval_request",
  "paca_auth_secondary_storage",
  "paca_agent_auth_audit",
  "paca_system_role",
  "paca_system_role_permission",
  "paca_user_system_role",
  "paca_organization_role",
  "paca_organization_role_permission",
  "paca_organization_member_role",
  "paca_project",
  "paca_project_role",
  "paca_role_permission",
  "paca_project_member",
  "paca_project_member_role",
  "paca_task_type",
  "paca_task_status",
  "paca_task_counter",
  "paca_sprint",
  "paca_custom_field_definition",
  "paca_task_view",
  "paca_view_task_position",
  "paca_task",
  "paca_task_assignee",
  "paca_task_activity",
  "paca_task_link",
  "paca_file",
  "paca_task_attachment",
  "paca_document",
  "paca_realtime_outbox",
] as const;

const targetInitiallyEmptyTables = [
  "user",
  "session",
  "account",
  "verification",
  "member",
  "invitation",
  "agent_host",
  "agent",
  "agent_capability_grant",
  "approval_request",
  "paca_auth_secondary_storage",
  "paca_agent_auth_audit",
  "paca_user_system_role",
  "paca_organization_member_role",
  "paca_project",
  "paca_project_role",
  "paca_role_permission",
  "paca_project_member",
  "paca_project_member_role",
  "paca_task_type",
  "paca_task_status",
  "paca_task_counter",
  "paca_sprint",
  "paca_custom_field_definition",
  "paca_task_view",
  "paca_view_task_position",
  "paca_task",
  "paca_task_assignee",
  "paca_task_activity",
  "paca_task_link",
  "paca_file",
  "paca_task_attachment",
  "paca_document",
  "paca_realtime_outbox",
] as const;

type RolePayload = {
  database_url?: unknown;
  id?: unknown;
  name?: unknown;
  password?: unknown;
  username?: unknown;
};

type ParsedRolePayload = Omit<RolePayload, "id" | "username"> & {
  id: string;
  username: string;
};

type TableEvidence = Record<string, { count: number; fingerprint: string }>;

function redact(value: string): string {
  return value
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s/]+@/giu, "$1[REDACTED]@")
    .replace(/("password"\s*:\s*")[^"]+/giu, "$1[REDACTED]")
    .slice(0, 4_000);
}

async function run(
  executable: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execFileAsync(executable, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    const exitCode = typeof failure.code === "number" ? failure.code : 1;
    if (options.allowFailure) {
      return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", exitCode };
    }
    throw new Error(
      `${executable.toUpperCase()}_FAILED: ${redact(failure.stderr || failure.stdout || failure.message)}`,
    );
  }
}

async function pscaleJSON(args: string[]): Promise<unknown> {
  const result = await run("pscale", [...args, "--format", "json"]);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`PSCALE_INVALID_JSON: ${redact(result.stdout)}`);
  }
}

function rolePayload(value: unknown, label: string): ParsedRolePayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}_INVALID`);
  }
  const role = value as RolePayload;
  if (
    typeof role.id !== "string" ||
    !role.id ||
    typeof role.username !== "string" ||
    !role.username
  ) {
    throw new Error(`${label}_IDENTITY_INVALID`);
  }
  return role as ParsedRolePayload;
}

function connectionString(role: RolePayload, label: string): string {
  if (typeof role.database_url !== "string" || !role.database_url) {
    throw new Error(`${label}_DATABASE_URL_MISSING`);
  }
  const url = new URL(role.database_url);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${label}_DATABASE_URL_INVALID`);
  }
  if (!url.password && typeof role.password === "string" && role.password) {
    url.password = role.password;
  }
  if (!url.password) throw new Error(`${label}_PASSWORD_MISSING`);
  url.searchParams.set("sslmode", "verify-full");
  url.searchParams.set("sslrootcert", "system");
  return url.toString();
}

function hyperdriveConnectionString(localDatabaseURL: string): string {
  const url = new URL(localDatabaseURL);
  url.searchParams.delete("sslrootcert");
  url.searchParams.delete("sslnegotiation");
  return url.toString();
}

function quotedIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function evidenceSQL(tables: readonly string[]): string {
  return tables
    .map((table) => {
      const identifier = quotedIdentifier(table);
      return `SELECT '${table}' AS table_name, count(*)::bigint AS row_count, md5(COALESCE(string_agg(to_jsonb(row_value)::text, E'\\n' ORDER BY to_jsonb(row_value)::text), '')) AS fingerprint FROM public.${identifier} AS row_value`;
    })
    .join(" UNION ALL ");
}

async function queryEvidence(
  databaseURL: string,
  tables: readonly string[],
): Promise<TableEvidence> {
  const query = `SELECT COALESCE(json_object_agg(table_name, json_build_object('count', row_count, 'fingerprint', fingerprint)), '{}') FROM (${evidenceSQL(tables)}) AS evidence`;
  const result = await run(psql, [
    "--dbname",
    databaseURL,
    "--no-psqlrc",
    "--tuples-only",
    "--no-align",
    "--set",
    "ON_ERROR_STOP=1",
    "--command",
    query,
  ]);
  const parsed: unknown = JSON.parse(result.stdout.trim());
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("DATABASE_EVIDENCE_INVALID");
  }
  const evidence: TableEvidence = {};
  for (const [table, raw] of Object.entries(parsed)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`DATABASE_EVIDENCE_${table.toUpperCase()}_INVALID`);
    }
    const row = raw as { count?: unknown; fingerprint?: unknown };
    const count = typeof row.count === "number" ? row.count : Number(row.count);
    if (!Number.isSafeInteger(count) || count < 0 || typeof row.fingerprint !== "string") {
      throw new Error(`DATABASE_EVIDENCE_${table.toUpperCase()}_INVALID`);
    }
    evidence[table] = { count, fingerprint: row.fingerprint };
  }
  return evidence;
}

function evidenceMatches(
  source: TableEvidence,
  target: TableEvidence,
  tables: readonly string[],
): boolean {
  return tables.every(
    (table) =>
      source[table]?.count === target[table]?.count &&
      source[table]?.fingerprint === target[table]?.fingerprint,
  );
}

async function migrationEvidence(databaseURL: string): Promise<string> {
  const result = await run(psql, [
    "--dbname",
    databaseURL,
    "--no-psqlrc",
    "--tuples-only",
    "--no-align",
    "--set",
    "ON_ERROR_STOP=1",
    "--command",
    "SELECT COALESCE(json_agg(json_build_array(id, checksum) ORDER BY applied_at, id)::text, '[]') FROM public.paca_schema_migration",
  ]);
  return result.stdout.trim();
}

async function createAdminRole(
  organizationID: string,
  branch: string,
  suffix: string,
): Promise<ParsedRolePayload> {
  const value = await pscaleJSON([
    "role",
    "create",
    database,
    branch,
    `paca-provision-${suffix}`,
    "--org",
    organizationID,
    "--inherited-roles",
    "postgres",
    "--ttl",
    "15m",
  ]);
  return rolePayload(value, `${suffix.toUpperCase()}_ADMIN_ROLE`);
}

function findHyperdriveID(output: string, name: string): string | null {
  for (const line of output.split("\n")) {
    if (!line.includes(name)) continue;
    const match = line.match(/\b[a-f0-9]{32}\b/iu);
    if (match) return match[0];
  }
  return null;
}

async function ensureHyperdrive(runtimeDatabaseURL: string): Promise<string> {
  const wranglerEnvironment = {
    ...process.env,
    WRANGLER_LOG_PATH: join(tmpdir(), "paca-provision-internal-wrangler.log"),
  };
  const listed = await run("pnpm", ["exec", "wrangler", "hyperdrive", "list"], {
    cwd: workerDirectory,
    env: wranglerEnvironment,
  });
  const existingID = findHyperdriveID(listed.stdout, hyperdriveName);
  const commonArgs = [
    "--connection-string",
    hyperdriveConnectionString(runtimeDatabaseURL),
    "--sslmode",
    "require",
    "--caching-disabled",
    "--origin-connection-limit",
    "5",
  ];
  const result = existingID
    ? await run(
        "pnpm",
        [
          "exec",
          "wrangler",
          "hyperdrive",
          "update",
          existingID,
          "--name",
          hyperdriveName,
          ...commonArgs,
        ],
        { cwd: workerDirectory, env: wranglerEnvironment },
      )
    : await run(
        "pnpm",
        ["exec", "wrangler", "hyperdrive", "create", hyperdriveName, ...commonArgs],
        { cwd: workerDirectory, env: wranglerEnvironment },
      );
  const id = existingID ?? result.stdout.match(/\b[a-f0-9]{32}\b/iu)?.[0];
  if (!id) throw new Error(`HYPERDRIVE_ID_MISSING: ${redact(result.stdout)}`);
  return id;
}

async function main(): Promise<void> {
  if (process.env.PACA_PROVISION_INTERNAL_CONFIRM !== confirmation) {
    throw new Error(`CONFIRMATION_REQUIRED:${confirmation}`);
  }
  if (!organization) throw new Error("PACA_PLANETSCALE_ORG_REQUIRED");
  if (!runtimeRoleID) throw new Error("PACA_PLANETSCALE_RUNTIME_ROLE_ID_REQUIRED");
  if (sourceBranch === targetBranch) throw new Error("SOURCE_AND_TARGET_BRANCH_MUST_DIFFER");

  const runtime = rolePayload(
    await pscaleJSON([
      "role",
      "reset",
      database,
      targetBranch,
      runtimeRoleID,
      "--org",
      organization,
      "--force",
    ]),
    "RUNTIME_ROLE",
  );
  const runtimeDatabaseURL = connectionString(runtime, "RUNTIME_ROLE");
  const runtimeDatabaseRole = runtime.username.split(".", 1)[0];
  if (!runtimeDatabaseRole) throw new Error("RUNTIME_DATABASE_ROLE_INVALID");

  const suffix = Date.now().toString(36);
  const [sourceAdmin, targetAdmin] = await Promise.all([
    createAdminRole(organization, sourceBranch, `source-${suffix}`),
    createAdminRole(organization, targetBranch, `target-${suffix}`),
  ]);
  const sourceDatabaseURL = connectionString(sourceAdmin, "SOURCE_ADMIN_ROLE");
  const targetDatabaseURL = connectionString(targetAdmin, "TARGET_ADMIN_ROLE");

  const [sourceMigrations, targetMigrations] = await Promise.all([
    migrationEvidence(sourceDatabaseURL),
    migrationEvidence(targetDatabaseURL),
  ]);
  if (sourceMigrations !== targetMigrations) throw new Error("MIGRATION_LEDGER_MISMATCH");

  await run(psql, [
    "--dbname",
    targetDatabaseURL,
    "--no-psqlrc",
    "--set",
    "ON_ERROR_STOP=1",
    "--set",
    `runtime_role=${runtimeDatabaseRole}`,
    "--file",
    grantSQL,
  ]);
  await run(psql, [
    "--dbname",
    targetDatabaseURL,
    "--no-psqlrc",
    "--set",
    "ON_ERROR_STOP=1",
    "--set",
    `runtime_role=${runtimeDatabaseRole}`,
    "--file",
    verifySQL,
  ]);

  const [sourceBefore, targetBefore] = await Promise.all([
    queryEvidence(sourceDatabaseURL, applicationTables),
    queryEvidence(targetDatabaseURL, applicationTables),
  ]);
  const targetIsEmpty = targetInitiallyEmptyTables.every(
    (table) => targetBefore[table]?.count === 0,
  );
  const targetAlreadyMatches =
    evidenceMatches(sourceBefore, targetBefore, targetInitiallyEmptyTables) &&
    applicationTables.every((table) => sourceBefore[table]?.count === targetBefore[table]?.count);

  let copied = false;
  if (!targetAlreadyMatches) {
    if (!targetIsEmpty) throw new Error("TARGET_BRANCH_HAS_DIVERGENT_APPLICATION_DATA");
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "paca-internal-seed-"));
    const dumpPath = join(temporaryDirectory, "data.sql");
    try {
      await run(pgDump, [
        "--dbname",
        sourceDatabaseURL,
        "--data-only",
        "--inserts",
        "--on-conflict-do-nothing",
        "--no-owner",
        "--no-privileges",
        "--exclude-table-data=public.paca_schema_migration",
        "--exclude-table-data=public.paca_attachment_migration_item",
        "--file",
        dumpPath,
      ]);
      await run(psql, [
        "--dbname",
        targetDatabaseURL,
        "--no-psqlrc",
        "--single-transaction",
        "--set",
        "ON_ERROR_STOP=1",
        "--command",
        'ALTER TABLE public.paca_task ALTER CONSTRAINT "paca_task_parent_task_id_paca_task_id_fk" DEFERRABLE INITIALLY DEFERRED',
        "--file",
        dumpPath,
        "--command",
        "SET CONSTRAINTS ALL IMMEDIATE",
        "--command",
        'ALTER TABLE public.paca_task ALTER CONSTRAINT "paca_task_parent_task_id_paca_task_id_fk" NOT DEFERRABLE',
      ]);
      copied = true;
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  const targetAfter = await queryEvidence(targetDatabaseURL, applicationTables);
  if (
    !applicationTables.every((table) => sourceBefore[table]?.count === targetAfter[table]?.count)
  ) {
    throw new Error("TARGET_ROW_COUNTS_MISMATCH");
  }
  if (!evidenceMatches(sourceBefore, targetAfter, targetInitiallyEmptyTables)) {
    throw new Error("TARGET_APPLICATION_DATA_MISMATCH");
  }

  await run(psql, [
    "--dbname",
    runtimeDatabaseURL,
    "--no-psqlrc",
    "--tuples-only",
    "--no-align",
    "--set",
    "ON_ERROR_STOP=1",
    "--command",
    'SELECT count(*) FROM public."user"',
  ]);
  const forbiddenLedgerRead = await run(
    psql,
    [
      "--dbname",
      runtimeDatabaseURL,
      "--no-psqlrc",
      "--tuples-only",
      "--no-align",
      "--command",
      "SELECT count(*) FROM public.paca_schema_migration",
    ],
    { allowFailure: true },
  );
  if (forbiddenLedgerRead.exitCode === 0) throw new Error("RUNTIME_ROLE_CAN_READ_MIGRATION_LEDGER");

  const hyperdriveID = await ensureHyperdrive(runtimeDatabaseURL);
  console.log(
    JSON.stringify({
      status: "ok",
      step: "provision-internal-database",
      database,
      sourceBranch,
      targetBranch,
      runtimeRoleId: runtime.id,
      hyperdriveId: hyperdriveID,
      copied,
      users: targetAfter.user?.count ?? 0,
      projects: targetAfter.paca_project?.count ?? 0,
      tasks: targetAfter.paca_task?.count ?? 0,
      agents: targetAfter.agent?.count ?? 0,
      temporaryAdminRoleTtl: "15m",
    }),
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? redact(error.message) : "UNKNOWN_ERROR";
  console.error(JSON.stringify({ status: "error", step: "provision-internal-database", message }));
  process.exitCode = 1;
});
