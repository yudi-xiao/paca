import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { repositoryDiscoverySchema } from "../src/github-delivery/discovery";
import { cleanupProductionSmokeUsers, productionSmokeFetch } from "./lib/production-smoke-auth";

const execute = promisify(execFile),
  origin = "https://paca.howlearnwood.com";
const organization = process.env.PACA_PLANETSCALE_ORG?.trim();
const id = crypto.randomUUID(),
  orgRole = crypto.randomUUID(),
  sysRole = crypto.randomUUID();
const email = `repository-smoke-${id}@paca.test`,
  projectName = `Repository Smoke ${id}`;
const log = (step: string) => console.log(JSON.stringify({ status: "ok", step }));
function check(v: unknown, code: string): asserts v {
  if (!v) throw Error(code);
}
function record(value: unknown): Record<string, unknown> {
  check(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "SMOKE_RESPONSE_INVALID",
  );
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  check(typeof value === "string" && value.length > 0, "SMOKE_IDENTIFIER_MISSING");
  return value;
}
async function pscale(args: string[]) {
  try {
    return (
      await execute("pscale", [...args, "--org", organization ?? "", "--format", "json"], {
        maxBuffer: 1048576,
        timeout: 20000,
      })
    ).stdout;
  } catch {
    throw Error("SMOKE_PSCALE_FAILED");
  }
}
async function request(path: string, method: string, cookie?: string, body?: unknown) {
  return productionSmokeFetch(`${origin}${path}`, {
    method,
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
}
async function json(r: Response, status: number, step: string) {
  if (r.status !== status) {
    const b = await r
      .json()
      .then(record)
      .catch(() => ({}) as Record<string, unknown>);
    console.log(
      JSON.stringify({
        step,
        httpStatus: r.status,
        code:
          typeof b.error_code === "string" && /^[A-Z0-9_]+$/.test(b.error_code)
            ? b.error_code
            : "UNKNOWN",
        requestId:
          typeof b.request_id === "string" && /^[a-f0-9-]{36}$/.test(b.request_id)
            ? b.request_id
            : undefined,
      }),
    );
    throw Error(`${step}_HTTP_${r.status}`);
  }
  return record(await r.json());
}
async function main() {
  check(
    process.env.PACA_GITHUB_REPOSITORY_SMOKE_CONFIRM === "RUN_PROD_GITHUB_REPOSITORY_SMOKE",
    "SMOKE_CONFIRM_REQUIRED",
  );
  check(organization, "PACA_PLANETSCALE_ORG_REQUIRED");
  check(
    !process.env.PACA_PLANETSCALE_TARGET_BRANCH ||
      process.env.PACA_PLANETSCALE_TARGET_BRANCH === "prod",
    "SMOKE_BRANCH_MUST_MATCH_PROD_DATABASE",
  );
  const health = await json(await request("/health", "GET"), 200, "HEALTH");
  check(health.environment === "prod", "WRONG_ENVIRONMENT");
  const role = record(
    JSON.parse(
      await pscale([
        "role",
        "create",
        "paca",
        "prod",
        `paca-repository-smoke-${Date.now()}`,
        "--inherited-roles",
        "postgres",
        "--ttl",
        "15m",
      ]),
    ),
  );
  const roleId = text(role.id);
  const url = new URL(text(role.database_url));
  if (!url.password) url.password = text(role.password);
  url.searchParams.delete("sslmode");
  url.searchParams.delete("sslrootcert");
  const client = new pg.Client({
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 15000,
  });
  let cookie: string | undefined, userId: string | undefined, projectId: string | undefined;
  const cleanup: string[] = [];
  try {
    await client.connect();
    const signup = await request("/api/auth/sign-up/email", "POST", undefined, {
      email,
      password: `Paca-${crypto.randomUUID()}-Aa1!`,
      name: "Repository Smoke",
    });
    const registered = await json(signup, 200, "SIGN_UP");
    userId = text(record(registered.user).id);
    const m = signup.headers
      .get("set-cookie")
      ?.match(/(?:^|,\s*)([^=;,\s]*session_token)=([^;,\s]+)/i);
    check(m, "SESSION_MISSING");
    cookie = `${m[1]}=${m[2]}`;
    await client.query(
      "INSERT INTO paca_organization_role (id,organization_id,name) VALUES ($1,'paca-default',$2)",
      [orgRole, `Repository Smoke ${id}`],
    );
    await client.query(
      "INSERT INTO paca_organization_role_permission (role_id,resource,action) VALUES ($1,'projects','create')",
      [orgRole],
    );
    await client.query(
      "INSERT INTO paca_organization_member_role (member_id,role_id,organization_id) SELECT id,$1,organization_id FROM member WHERE organization_id='paca-default' AND user_id=$2",
      [orgRole, userId],
    );
    projectId = text(
      record(
        (
          await json(
            await request("/api/v1/projects", "POST", cookie, { name: projectName }),
            201,
            "CREATE_PROJECT",
          )
        ).data,
      ).id,
    );
    // The first signup bootstraps an administrator. Reduce only this
    // disposable fixture's system roles to exercise the ordinary permission gate.
    await client.query("DELETE FROM paca_user_system_role WHERE user_id=$1", [userId]);
    const path = `/api/v1/projects/${projectId}/github-repository`,
      input = {
        owner: "yudi-xiao",
        repository: "paca",
        pullNumber: 1,
        reviewerLogins: ["yudi-xiao"],
      };
    await json(
      await request(`${path}/discover`, "POST", undefined, input),
      401,
      "ANONYMOUS_DISCOVERY",
    );
    await json(
      await request(`${path}/discover`, "POST", cookie, input),
      403,
      "SYSTEM_PERMISSION_REQUIRED",
    );
    log("repository-discovery-session-and-system-permission");
    await client.query("INSERT INTO paca_system_role (id,name) VALUES ($1,$2)", [
      sysRole,
      `Repository Smoke ${id}`,
    ]);
    await client.query(
      "INSERT INTO paca_system_role_permission (role_id,resource,action) VALUES ($1,'settings','write')",
      [sysRole],
    );
    await client.query("INSERT INTO paca_user_system_role (user_id,role_id) VALUES ($1,$2)", [
      userId,
      sysRole,
    ]);
    const r = await request(`${path}/discover`, "POST", cookie, input);
    check(r.headers.get("cache-control")?.includes("no-store"), "CACHE_POLICY");
    const found = repositoryDiscoverySchema.parse((await json(r, 200, "DISCOVER")).data);
    check(
      found.repositoryId === 1348120048 &&
        found.installationId === 169867188 &&
        found.reviewers[0]?.id === 5916167,
      "DISCOVERY_SCOPE",
    );
    check(
      found.checks.length === 3 && found.checks.every((c) => c.appId === 15368),
      "DISCOVERY_CHECKS",
    );
    const command = {
      requestId: crypto.randomUUID(),
      expectedVersion: 0,
      repositoryId: found.repositoryId,
      installationId: found.installationId,
      policy: {
        owner: found.owner,
        repository: found.repository,
        requiredChecks: found.checks.map((c) => ({ name: c.name, appId: c.appId })),
        requiredApprovals: 0,
        reviewerIds: found.reviewers.map((u) => u.id),
        maxCheckAgeSeconds: 86400,
      },
    };
    const saved = record(
      (await json(await request(path, "PUT", cookie, command), 200, "CONFIGURE")).data,
    );
    check(saved.version === 1, "CONFIGURE_VERSION");
    const replay = record(
      (await json(await request(path, "PUT", cookie, command), 200, "REPLAY")).data,
    );
    check(replay.version === 1, "REPLAY_DUPLICATED");
    const read = record((await json(await request(path, "GET", cookie), 200, "READ")).data);
    const storedChecks = record(read.policy).requiredChecks;
    check(
      read.repositoryId === found.repositoryId &&
        Array.isArray(storedChecks) &&
        storedChecks.length === 3,
      "READ_BINDING",
    );
    await json(
      await request(path, "PUT", cookie, { ...command, requestId: crypto.randomUUID() }),
      409,
      "VERSION_CONFLICT",
    );
    log("repository-discovery-save-replay-and-version-conflict");
    await client.query("DELETE FROM paca_user_system_role WHERE user_id=$1 AND role_id=$2", [
      userId,
      sysRole,
    ]);
    await json(await request(`${path}/discover`, "POST", cookie, input), 403, "REVOKED_DISCOVERY");
    log("repository-discovery-current-permission-revocation");
  } finally {
    if (cookie && projectId) {
      const r = await request(`/api/v1/projects/${projectId}`, "DELETE", cookie).catch(() => null);
      if (r?.status !== 200) cleanup.push("PROJECT_ARCHIVE");
    }
    if (cookie) {
      const r = await request("/api/auth/sign-out", "POST", cookie, {}).catch(() => null);
      if (r?.status !== 200) cleanup.push("SIGN_OUT");
    }
    try {
      await client.query("BEGIN");
      if (projectId && userId) {
        const r = await client.query(
          "DELETE FROM paca_project WHERE id=$1 AND name=$2 AND created_by=$3",
          [projectId, projectName, userId],
        );
        check(r.rowCount === 1, "PROJECT_CLEANUP_MISMATCH");
      }
      await client.query("DELETE FROM paca_organization_role WHERE id=$1 AND name=$2", [
        orgRole,
        `Repository Smoke ${id}`,
      ]);
      await client.query("DELETE FROM paca_system_role WHERE id=$1 AND name=$2", [
        sysRole,
        `Repository Smoke ${id}`,
      ]);
      if (userId)
        await client.query('DELETE FROM "user" WHERE id=$1 AND email=$2', [userId, email]);
      await client.query("COMMIT");
    } catch {
      await client.query("ROLLBACK").catch(() => {});
      cleanup.push("DATABASE_CLEANUP");
    }
    await client.end().catch(() => cleanup.push("DISCONNECT"));
    await pscale(["role", "delete", "paca", "prod", roleId, "--force"]).catch(() =>
      cleanup.push("ROLE_CLEANUP"),
    );
    if (cleanup.length)
      console.error(
        JSON.stringify({ status: "error", step: "repository-smoke-cleanup", codes: cleanup }),
      );
    check(!cleanup.length, "SMOKE_CLEANUP_FAILED");
  }
  log("repository-settings-prod-smoke-complete-and-fixtures-cleaned");
}
main()
  .finally(cleanupProductionSmokeUsers)
  .catch((e) => {
    console.error(
      JSON.stringify({
        status: "error",
        code:
          e instanceof Error && /^[A-Z0-9_]+$/.test(e.message)
            ? e.message
            : "REPOSITORY_SMOKE_FAILED",
      }),
    );
    process.exitCode = 1;
  });
