import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import {
  fetchWithDelegatedAgent,
  registerDelegatedAgentWithCapabilities,
  writeDelegatedAgentConfig,
} from "../src/agent-auth/agent-client";
import { type AgentHostConfig, generateAgentHostIdentity } from "../src/agent-auth/host-enrollment";
import { cleanupProductionSmokeUsers, productionSmokeFetch } from "./lib/production-smoke-auth";

const origin = "https://paca.howlearnwood.com";
const execute = promisify(execFile);
const directory = resolve(import.meta.dirname, "..");
const organization = process.env.PACA_PLANETSCALE_ORG?.trim();
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw Error("SMOKE_RESPONSE_INVALID");
  return value as RecordValue;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw Error("SMOKE_IDENTIFIER_MISSING");
  return value;
}
async function pscale(args: string[]): Promise<string> {
  try {
    return (
      await execute("pscale", [...args, "--org", organization ?? "", "--format", "json"], {
        cwd: directory,
        maxBuffer: 1024 * 1024,
      })
    ).stdout;
  } catch {
    throw Error("SMOKE_PSCALE_FAILED");
  }
}
function cookieFrom(response: Response): string {
  const value = response.headers.get("set-cookie") ?? "";
  const match = value.match(/(?:^|,\s*)([^=;,\s]*session_token)=([^;,\s]+)/i);
  if (!match?.[1] || !match[2]) throw Error("SMOKE_SESSION_MISSING");
  return `${match[1]}=${match[2]}`;
}
async function request(path: string, method: string, cookie?: string, body?: RecordValue) {
  return productionSmokeFetch(`${origin}${path}`, {
    method,
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
}
async function json(response: Response, status: number, step: string): Promise<RecordValue> {
  if (response.status !== status) throw Error(`${step}_HTTP_${response.status}`);
  return record(await response.json());
}
function items(page: RecordValue): RecordValue[] {
  if (!Array.isArray(page.items)) throw Error("SEARCH_ITEMS_INVALID");
  return page.items.map(record);
}
function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw Error(code);
}
function log(step: string) {
  console.log(JSON.stringify({ status: "ok", step }));
}

async function main() {
  check(
    process.env.PACA_SEARCH_SMOKE_CONFIRM === "RUN_PROD_SEARCH_SMOKE",
    "PACA_SEARCH_SMOKE_CONFIRM_REQUIRED",
  );
  check(organization, "PACA_PLANETSCALE_ORG_REQUIRED");
  check(
    !process.env.PACA_PLANETSCALE_TARGET_BRANCH ||
      process.env.PACA_PLANETSCALE_TARGET_BRANCH === "prod",
    "SMOKE_BRANCH_MUST_MATCH_PROD_DATABASE",
  );
  const suffix = crypto.randomUUID();
  const email = `search-smoke-${suffix}@paca.test`;
  const roleId = crypto.randomUUID();
  const hostManagerRoleId = crypto.randomUUID();
  const projectName = `Search Smoke ${suffix}`;
  const role = record(
    JSON.parse(
      await pscale([
        "role",
        "create",
        "paca",
        "prod",
        `paca-search-smoke-${Date.now()}`,
        "--inherited-roles",
        "postgres",
        "--ttl",
        "15m",
      ]),
    ),
  );
  const roleIdentifier = text(role.id);
  const url = new URL(text(role.database_url));
  if (!url.password) url.password = text(role.password);
  url.searchParams.delete("sslmode");
  url.searchParams.delete("sslrootcert");
  const client = new pg.Client({
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: true },
  });
  let cookie: string | undefined;
  let userId: string | undefined;
  let projectId: string | undefined;
  let agentId: string | undefined;
  let hostId: string | undefined;
  let privateDirectory: string | undefined;
  const cleanupErrors: string[] = [];
  try {
    await client.connect();
    const health = await json(await request("/health", "GET"), 200, "HEALTH");
    check(health.environment === "prod", "SMOKE_WRONG_ENVIRONMENT");
    const registrationResponse = await request("/api/auth/sign-up/email", "POST", undefined, {
      email,
      password: `Paca-${crypto.randomUUID()}-Aa1!`,
      name: "Search Smoke",
    });
    const registration = await json(registrationResponse, 200, "SIGN_UP");
    cookie = cookieFrom(registrationResponse);
    userId = text(record(registration.user).id);
    // Test-only fixture in the sole permission schema. All exercised operations
    // still use the public API, Better Auth Session, and pacaPermission evaluator.
    await client.query("BEGIN");
    try {
      await client.query(
        "INSERT INTO paca_organization_role (id, organization_id, name) VALUES ($1, 'paca-default', $2)",
        [roleId, `Search Smoke Creator ${suffix}`],
      );
      await client.query(
        "INSERT INTO paca_organization_role_permission (role_id, resource, action) VALUES ($1, 'projects', 'create')",
        [roleId],
      );
      const assigned = await client.query(
        "INSERT INTO paca_organization_member_role (member_id, role_id, organization_id) SELECT id, $1, organization_id FROM member WHERE organization_id = 'paca-default' AND user_id = $2",
        [roleId, userId],
      );
      check(assigned.rowCount === 1, "SMOKE_MEMBER_MISSING");
      await client.query("INSERT INTO paca_system_role (id, name) VALUES ($1, $2)", [
        hostManagerRoleId,
        `Search Smoke Host Manager ${suffix}`,
      ]);
      await client.query(
        "INSERT INTO paca_system_role_permission (role_id, resource, action) VALUES ($1, 'agents', 'write')",
        [hostManagerRoleId],
      );
      await client.query("INSERT INTO paca_user_system_role (user_id, role_id) VALUES ($1, $2)", [
        userId,
        hostManagerRoleId,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    projectId = text(
      record(
        (
          await json(
            await request("/api/v1/projects", "POST", cookie, {
              name: projectName,
            }),
            201,
            "CREATE_PROJECT",
          )
        ).data,
      ).id,
    );
    const projectPath = `/api/v1/projects/${projectId}`;
    const needle = `正文验证${suffix.slice(0, 8)}%_`;
    const body = [
      {
        id: crypto.randomUUID(),
        type: "paragraph",
        props: { ignored: "metadata-only-secret" },
        content: [
          { type: "text", text: needle.slice(0, 4), styles: { bold: true } },
          { type: "text", text: needle.slice(4), styles: {} },
        ],
        children: [],
      },
    ];
    const tasks: string[] = [];
    for (let i = 0; i < 3; i++) {
      tasks.push(
        text(
          record(
            (
              await json(
                await request(`${projectPath}/tasks`, "POST", cookie, {
                  title: `Fixture ${i}`,
                  description: body,
                }),
                201,
                "CREATE_TASK",
              )
            ).data,
          ).id,
        ),
      );
    }
    const documentId = text(
      record(
        (
          await json(
            await request(`${projectPath}/docs`, "POST", cookie, {
              title: "Document fixture",
              content: body,
            }),
            201,
            "CREATE_DOCUMENT",
          )
        ).data,
      ).id,
    );
    const search = async (kind: string, query: string, cursor?: string) => {
      const parameters = new URLSearchParams({
        q: query,
        limit: "1",
        ...(cursor ? { cursor } : {}),
      });
      const response = await request(`${projectPath}/search/${kind}?${parameters}`, "GET", cookie);
      check(
        response.headers.get("cache-control")?.includes("no-store"),
        "SEARCH_CACHE_POLICY_INVALID",
      );
      return record((await json(response, 200, "SEARCH")).data);
    };
    const first = await search("tasks", needle);
    check(
      items(first).length === 1 && items(first)[0]?.matched_in === "content",
      "BODY_SEARCH_MISSING",
    );
    const second = await search("tasks", needle, text(first.next_cursor));
    const third = await search("tasks", needle, text(second.next_cursor));
    check(
      new Set([...items(first), ...items(second), ...items(third)].map((item) => item.id)).size ===
        3,
      "SEARCH_PAGINATION_DUPLICATE",
    );
    check(third.next_cursor === null, "SEARCH_PAGINATION_NOT_TERMINAL");
    check(
      items(await search("docs", needle))[0]?.id === documentId,
      "DOCUMENT_BODY_SEARCH_MISSING",
    );
    check(items(await search("docs", "metadata-only-secret")).length === 0, "SEARCH_METADATA_LEAK");
    check(
      (await request(`${projectPath}/search/tasks?q=${encodeURIComponent(needle)}`, "GET"))
        .status === 401,
      "ANONYMOUS_SEARCH_ALLOWED",
    );
    log("search-user-body-literal-pagination-and-auth");

    const identity = await generateAgentHostIdentity();
    const hostResponse = await json(
      await request("/api/auth/host/create", "POST", cookie, {
        name: `Search Smoke Host ${suffix}`,
        public_key: identity.publicKey,
        default_capabilities: [],
      }),
      200,
      "CREATE_HOST",
    );
    hostId = text(hostResponse.hostId);
    await json(
      await request(`/api/v1/agent/hosts/${hostId}/runtime`, "PUT", cookie, {
        approved_labels: ["task:execute", "harness:codex"],
      }),
      200,
      "APPROVE_HOST_LABELS",
    );
    const hostConfig: AgentHostConfig = {
      version: 1,
      providerOrigin: origin,
      issuer: `${origin}/api/auth`,
      defaultLocation: `${origin}/api/auth/capability/execute`,
      hostId,
      hostName: `Search Smoke Host ${suffix}`,
      keyAlgorithm: "Ed25519",
      ...identity,
      enrolledAt: new Date().toISOString(),
    };
    const validUntil = new Date(Date.now() + 10 * 60_000).toISOString();
    const agent = await registerDelegatedAgentWithCapabilities({
      hostConfig,
      agentName: `Search Smoke Agent ${suffix}`,
      capabilityRequests: [
        {
          capability: "task.read",
          constraints: { organizationId: "paca-default", projectId, taskId: tasks[0], validUntil },
        },
        {
          capability: "document.read",
          constraints: { organizationId: "paca-default", projectId, documentId, validUntil },
        },
        {
          capability: "task.execute",
          constraints: {
            organizationId: "paca-default",
            projectId,
            taskId: tasks[0],
            operationMode: "execute",
            action: { in: ["claim", "renew", "checkpoint", "complete", "fail", "cancel_ack"] },
            validUntil,
          },
        },
      ],
      reason: "Temporary production search protocol verification",
      bindingMessage: "Only one fixture task and one document; expires in ten minutes.",
    });
    agentId = agent.config.agentId;
    await json(
      await request("/api/auth/agent/approve-capability", "POST", cookie, {
        agent_id: agentId,
        user_code: agent.approval.userCode,
        action: "approve",
      }),
      200,
      "APPROVE_AGENT",
    );
    privateDirectory = await mkdtemp(resolve(tmpdir(), "paca-search-agent-"));
    const configPath = resolve(privateDirectory, "agent.json");
    await writeDelegatedAgentConfig(configPath, agent.config);
    const cleanEnvironment = { ...process.env };
    for (const key of [
      "PACA_API_KEY",
      "PACA_CAPABILITY_BROKER_TOKEN",
      "PACA_CAPABILITY_BROKER_URL",
      "PACA_CAPABILITY_BROKER_CONFIG",
      "PACA_AGENT_ID",
    ])
      delete cleanEnvironment[key];
    const doctor = await execute(
      process.execPath,
      [resolve(directory, "../../apps/mcp/build/index.js"), "--doctor"],
      {
        env: { ...cleanEnvironment, PACA_AGENT_CONFIG: configPath, PACA_PROJECT_ID: projectId },
        timeout: 20_000,
        maxBuffer: 16000,
      },
    ).catch(() => {
      throw Error("LOCAL_AGENT_DOCTOR_FAILED");
    });
    check(record(JSON.parse(doctor.stdout)).status === "connected", "LOCAL_AGENT_NOT_CONNECTED");
    const stdio = await execute(
      process.execPath,
      [resolve(directory, "../../apps/mcp/scripts/smoke-local-agent.mjs")],
      {
        env: {
          ...cleanEnvironment,
          PACA_AGENT_CONFIG: configPath,
          PACA_PROJECT_ID: projectId,
          PACA_SMOKE_TASK_ID: text(tasks[0]),
          PACA_SMOKE_DOCUMENT_ID: documentId,
          PACA_SMOKE_SEARCH_QUERY: needle,
          PACA_SMOKE_USER_COOKIE: cookie,
          PACA_LOCAL_AGENT_SMOKE_CONFIRM: "RUN_PROD_LOCAL_AGENT_SMOKE",
        },
        timeout: 180_000,
        maxBuffer: 16000,
      },
    ).catch((error: unknown) => {
      const output = record(error).stderr;
      let code = "LOCAL_AGENT_STDIO_FAILED";
      if (typeof output === "string") {
        try {
          const candidate = record(JSON.parse(output.trim())).code;
          if (typeof candidate === "string" && /^[A-Z0-9_]+$/.test(candidate)) code = candidate;
        } catch {
          /* Never print raw child output. */
        }
      }
      throw Error(code);
    });
    check(record(JSON.parse(stdio.stdout)).status === "ok", "LOCAL_AGENT_STDIO_FAILED");
    log("local-agent-stdio-search-and-task-lease");
    const agentSearch = async () =>
      record(
        (
          await json(
            await fetchWithDelegatedAgent({
              config: agent.config,
              path: `/api/v1/agent/projects/${projectId}/search/tasks`,
              capabilities: ["task.read"],
              init: {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ query: needle }),
                signal: AbortSignal.timeout(20_000),
              },
            }),
            200,
            "AGENT_SEARCH",
          )
        ).data,
      );
    const agentResult = await agentSearch();
    check(
      items(agentResult).length === 1 && items(agentResult)[0]?.id === tasks[0],
      "AGENT_SCOPE_LEAK",
    );
    await json(
      await request("/api/auth/paca-agent/revoke-capability", "POST", cookie, {
        agent_id: agentId,
        capabilities: ["task.read"],
      }),
      200,
      "REVOKE_TASK_READ",
    );
    const revoked = await fetchWithDelegatedAgent({
      config: agent.config,
      path: `/api/v1/agent/projects/${projectId}/search/tasks`,
      capabilities: ["task.read"],
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: needle }),
        signal: AbortSignal.timeout(20_000),
      },
    });
    check([401, 403].includes(revoked.status), "REVOKED_AGENT_SEARCH_ALLOWED");
    log("search-local-agent-doctor-exact-grant-and-revocation");
    check(
      (await request(`${projectPath}/docs/${documentId}`, "DELETE", cookie)).status === 204,
      "ARCHIVE_DOCUMENT_FAILED",
    );
    check(items(await search("docs", needle)).length === 0, "SEARCH_DELETED_DOCUMENT_LEAK");
    log("search-deleted-content-hidden");
  } finally {
    if (cookie && agentId) {
      const response = await request("/api/auth/agent/revoke", "POST", cookie, {
        agent_id: agentId,
      }).catch(() => null);
      if (response?.status !== 200) cleanupErrors.push("AGENT_REVOKE_FAILED");
    }
    if (cookie && hostId) {
      const response = await request("/api/auth/host/revoke", "POST", cookie, {
        host_id: hostId,
      }).catch(() => null);
      if (response?.status !== 200) cleanupErrors.push("HOST_REVOKE_FAILED");
    }
    if (cookie && projectId) {
      const response = await request(`/api/v1/projects/${projectId}`, "DELETE", cookie).catch(
        () => null,
      );
      if (response?.status !== 200) cleanupErrors.push("PROJECT_ARCHIVE_FAILED");
    }
    if (cookie) {
      const response = await request("/api/auth/sign-out", "POST", cookie, {}).catch(() => null);
      if (response?.status !== 200) cleanupErrors.push("SIGN_OUT_FAILED");
    }
    try {
      await client.query("BEGIN");
      if (projectId && userId) {
        const deleted = await client.query(
          "DELETE FROM paca_project WHERE id = $1 AND name = $2 AND created_by = $3",
          [projectId, projectName, userId],
        );
        check(deleted.rowCount === 1, "SMOKE_PROJECT_CLEANUP_MISMATCH");
      }
      await client.query("DELETE FROM paca_organization_role WHERE id = $1 AND name = $2", [
        roleId,
        `Search Smoke Creator ${suffix}`,
      ]);
      await client.query("DELETE FROM paca_system_role WHERE id = $1 AND name = $2", [
        hostManagerRoleId,
        `Search Smoke Host Manager ${suffix}`,
      ]);
      if (userId)
        await client.query('DELETE FROM "user" WHERE id = $1 AND email = $2', [userId, email]);
      await client.query("COMMIT");
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      cleanupErrors.push("DATABASE_CLEANUP_FAILED");
    }
    await client.end().catch(() => cleanupErrors.push("DATABASE_DISCONNECT_FAILED"));
    if (privateDirectory)
      await rm(privateDirectory, { recursive: true, force: true }).catch(() =>
        cleanupErrors.push("PRIVATE_FILE_CLEANUP_FAILED"),
      );
    await pscale(["role", "delete", "paca", "prod", roleIdentifier, "--force"]).catch(() =>
      cleanupErrors.push("TEMP_ROLE_DELETE_FAILED"),
    );
    if (cleanupErrors.length) {
      console.error(
        JSON.stringify({ status: "error", step: "search-cleanup", codes: cleanupErrors }),
      );
    }
  }
  check(cleanupErrors.length === 0, "SEARCH_SMOKE_CLEANUP_FAILED");
  log("search-prod-smoke-complete");
}
main()
  .finally(cleanupProductionSmokeUsers)
  .catch((error: unknown) => {
    console.error(
      JSON.stringify({
        status: "error",
        step: "search-prod-smoke",
        code:
          error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
            ? error.message
            : "SEARCH_SMOKE_FAILED",
      }),
    );
    process.exitCode = 1;
  });
