import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import pg from "pg";

type JsonRecord = Record<string, unknown>;
type HeadersWithSetCookie = Headers & { getSetCookie?: () => string[] };

const baseURL = "https://paca.howlearnwood.com";
const database = "paca";
const branch = "internal";
const execFileAsync = promisify(execFile);
const organization = process.env.PACA_PLANETSCALE_ORG?.trim();
const workerDirectory = resolve(import.meta.dirname, "..");

type RolePayload = { id?: unknown; database_url?: unknown; password?: unknown };

async function pscale(args: string[]): Promise<string> {
  try {
    return (
      await execFileAsync("pscale", [...args, "--org", organization ?? "", "--format", "json"], {
        cwd: workerDirectory,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout;
  } catch {
    throw new Error("AUTOMATION_SMOKE_PSCALE_FAILED");
  }
}

function parseRole(value: string): { id: string; databaseURL: string } {
  const role = JSON.parse(value) as RolePayload;
  if (typeof role.id !== "string" || typeof role.database_url !== "string") {
    throw new Error("AUTOMATION_SMOKE_TEMP_ROLE_INVALID");
  }
  const url = new URL(role.database_url);
  if (!url.password && typeof role.password === "string") url.password = role.password;
  if (!url.password) throw new Error("AUTOMATION_SMOKE_TEMP_ROLE_PASSWORD_MISSING");
  url.searchParams.delete("sslrootcert");
  url.searchParams.delete("sslmode");
  return { id: role.id, databaseURL: url.toString() };
}

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function stringField(value: unknown, key: string): string {
  const field = record(value)?.[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`AUTOMATION_SMOKE_${key.toUpperCase()}_MISSING`);
  }
  return field;
}

function sessionCookie(response: Response): string {
  const headers = response.headers as HeadersWithSetCookie;
  for (const header of headers.getSetCookie?.() ?? [headers.get("set-cookie") ?? ""]) {
    const match = header.match(/(?:^|,\s*)([^=;,\s]*session_token)=([^;,\s]+)/i);
    if (match?.[1] && match[2]) return `${match[1]}=${match[2]}`;
  }
  throw new Error("AUTOMATION_SMOKE_SESSION_COOKIE_MISSING");
}

async function request(path: string, method: string, cookie?: string, body?: JsonRecord) {
  const headers = new Headers({ origin: baseURL });
  if (cookie) headers.set("cookie", cookie);
  if (body) headers.set("content-type", "application/json");
  return fetch(`${baseURL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
}

async function expectJson(response: Response, status: number, step: string): Promise<JsonRecord> {
  if (response.status !== status) {
    throw new Error(`${step}_HTTP_${response.status}`);
  }
  const value = record(await response.json());
  if (!value) throw new Error(`${step}_BODY_INVALID`);
  return value;
}

async function waitForCompletedRun(path: string, cookie: string, taskId: string): Promise<string> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const history = await expectJson(
      await request(`${path}/runs?limit=10`, "GET", cookie),
      200,
      "WORKFLOW_RUN_HISTORY",
    );
    const items = record(history.data)?.items;
    if (!Array.isArray(items)) throw new Error("AUTOMATION_SMOKE_RUN_HISTORY_INVALID");
    const matching = items.map(record).find((row) => row?.task_id === taskId);
    if (matching?.status === "failed") throw new Error("AUTOMATION_SMOKE_WORKFLOW_FAILED");
    if (matching?.status === "completed") return stringField(matching, "id");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error("AUTOMATION_SMOKE_WORKFLOW_TIMEOUT");
}

async function main(): Promise<void> {
  if (process.env.PACA_AUTOMATION_SMOKE_CONFIRM !== "RUN_INTERNAL_AUTOMATION_SMOKE") {
    throw new Error("PACA_AUTOMATION_SMOKE_CONFIRM_REQUIRED");
  }
  if (!organization) throw new Error("PACA_PLANETSCALE_ORG_REQUIRED");
  if (
    process.env.PACA_PLANETSCALE_TARGET_BRANCH?.trim() !== undefined &&
    process.env.PACA_PLANETSCALE_TARGET_BRANCH?.trim() !== branch
  ) {
    throw new Error("AUTOMATION_SMOKE_TARGET_BRANCH_MUST_BE_INTERNAL");
  }

  const suffix = crypto.randomUUID();
  const email = `automation-smoke-${suffix}@paca.test`;
  const password = `Paca-${crypto.randomUUID()}-Aa1!`;
  const testRoleId = crypto.randomUUID();
  const projectName = `Automation Smoke ${suffix}`;
  const role = parseRole(
    await pscale([
      "role",
      "create",
      database,
      branch,
      `paca-automation-smoke-${Date.now()}`,
      "--inherited-roles",
      "postgres",
      "--ttl",
      "15m",
    ]),
  );
  const client = new pg.Client({
    connectionString: role.databaseURL,
    ssl: { rejectUnauthorized: true },
  });
  let cookie: string | undefined;
  let userId: string | undefined;
  let projectId: string | undefined;
  let automationId: string | undefined;
  let smokeCompleted = false;
  let cleanupFailure: string | null = null;

  try {
    await client.connect();
    const health = await expectJson(await request("/health", "GET"), 200, "HEALTH");
    if (health.environment !== "internal") throw new Error("AUTOMATION_SMOKE_WRONG_ENVIRONMENT");

    const signUp = await request("/api/auth/sign-up/email", "POST", undefined, {
      email,
      name: "Automation Smoke",
      password,
    });
    const signUpBody = await expectJson(signUp, 200, "SIGN_UP");
    userId = stringField(signUpBody.user, "id");
    cookie = sessionCookie(signUp);

    await client.query("BEGIN");
    try {
      const membership = await client.query<{ id: string }>(
        'SELECT id FROM "member" WHERE organization_id = $1 AND user_id = $2',
        ["paca-default", userId],
      );
      const memberId = membership.rows[0]?.id;
      if (!memberId) throw new Error("AUTOMATION_SMOKE_ORGANIZATION_MEMBER_MISSING");
      await client.query(
        "INSERT INTO paca_organization_role (id, organization_id, name) VALUES ($1, $2, $3)",
        [testRoleId, "paca-default", `Automation Smoke Creator ${suffix}`],
      );
      await client.query(
        "INSERT INTO paca_organization_role_permission (role_id, resource, action) VALUES ($1, 'projects', 'create')",
        [testRoleId],
      );
      await client.query(
        "INSERT INTO paca_organization_member_role (member_id, role_id, organization_id) VALUES ($1, $2, $3)",
        [memberId, testRoleId, "paca-default"],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    const project = await expectJson(
      await request("/api/v1/projects", "POST", cookie, {
        name: projectName,
      }),
      201,
      "PROJECT_CREATE",
    );
    projectId = stringField(project.data, "id");
    const base = `/api/v1/projects/${projectId}/automations`;

    const created = await expectJson(
      await request(base, "POST", cookie, { name: `Draft ${suffix}` }),
      201,
      "GRAPH_CREATE",
    );
    automationId = stringField(created.data, "id");
    if (record(created.data)?.status !== "inactive") {
      throw new Error("AUTOMATION_SMOKE_GRAPH_NOT_INACTIVE");
    }
    const graphPath = `${base}/${automationId}`;
    const emptyRuns = await expectJson(
      await request(`${graphPath}/runs?limit=10`, "GET", cookie),
      200,
      "RUN_HISTORY_EMPTY",
    );
    const runItems = record(emptyRuns.data)?.items;
    if (!Array.isArray(runItems) || runItems.length !== 0) {
      throw new Error("AUTOMATION_SMOKE_RUN_HISTORY_INVALID");
    }

    const trigger = await expectJson(
      await request(`${graphPath}/nodes`, "POST", cookie, {
        kind: "trigger",
        type: "task_created",
        config: {},
        pos_x: 0,
        pos_y: 0,
      }),
      201,
      "TRIGGER_CREATE",
    );
    const action = await expectJson(
      await request(`${graphPath}/nodes`, "POST", cookie, {
        kind: "action",
        type: "update_task",
        config: { update: { importance: 1 } },
        pos_x: 200,
        pos_y: 0,
      }),
      201,
      "ACTION_CREATE",
    );
    const triggerId = stringField(trigger.data, "id");
    const actionId = stringField(action.data, "id");
    const edge = await expectJson(
      await request(`${graphPath}/edges`, "POST", cookie, {
        source_node_id: triggerId,
        target_node_id: actionId,
      }),
      201,
      "EDGE_CREATE",
    );
    const edgeId = stringField(edge.data, "id");

    const graph = await expectJson(await request(graphPath, "GET", cookie), 200, "GRAPH_READ");
    const graphData = record(graph.data);
    if (
      record(graphData?.automation)?.id !== automationId ||
      !Array.isArray(graphData?.nodes) ||
      graphData.nodes.length !== 2 ||
      !Array.isArray(graphData?.edges) ||
      graphData.edges.length !== 1
    ) {
      throw new Error("AUTOMATION_SMOKE_GRAPH_MISMATCH");
    }

    const invalidEdge = await expectJson(
      await request(`${graphPath}/edges`, "POST", cookie, {
        source_node_id: actionId,
        target_node_id: triggerId,
      }),
      400,
      "EDGE_INTO_TRIGGER_REJECTED",
    );
    if (invalidEdge.error_code !== "AUTOMATION_EDGE_INTO_TRIGGER") {
      throw new Error("AUTOMATION_SMOKE_INVALID_EDGE_CODE");
    }
    const activation = await expectJson(
      await request(`${graphPath}/activate`, "POST", cookie),
      200,
      "GRAPH_ACTIVATE",
    );
    if (record(activation.data)?.status !== "active") {
      throw new Error("AUTOMATION_SMOKE_GRAPH_NOT_ACTIVE");
    }
    const activeEdit = await expectJson(
      await request(`${graphPath}/nodes/${actionId}`, "PATCH", cookie, {
        config: { update: { importance: 2 } },
      }),
      409,
      "ACTIVE_GRAPH_EDIT_REJECTED",
    );
    if (activeEdit.error_code !== "AUTOMATION_ACTIVE_GRAPH_IMMUTABLE") {
      throw new Error("AUTOMATION_SMOKE_ACTIVE_EDIT_CODE_INVALID");
    }
    const actionTask = await expectJson(
      await request(`/api/v1/projects/${projectId}/tasks`, "POST", cookie, {
        title: `Action task ${suffix}`,
      }),
      201,
      "ACTION_TASK_CREATE",
    );
    const actionTaskId = stringField(actionTask.data, "id");
    const actionRunId = await waitForCompletedRun(graphPath, cookie, actionTaskId);
    const updatedTask = await expectJson(
      await request(`/api/v1/projects/${projectId}/tasks/${actionTaskId}`, "GET", cookie),
      200,
      "ACTION_TASK_READ",
    );
    if (record(updatedTask.data)?.importance !== 1) {
      throw new Error("AUTOMATION_SMOKE_TASK_NOT_UPDATED");
    }
    const activity = await client.query<{ actor_type: string; content: JsonRecord }>(
      "SELECT actor_type, content FROM paca_task_activity WHERE task_id = $1 AND activity_type = 'task.updated'",
      [actionTaskId],
    );
    if (
      activity.rows.length !== 1 ||
      activity.rows[0]?.actor_type !== "system" ||
      activity.rows[0]?.content.automation_run_id !== actionRunId
    ) {
      throw new Error("AUTOMATION_SMOKE_TASK_AUDIT_INVALID");
    }
    await expectJson(
      await request(`${graphPath}/deactivate`, "POST", cookie),
      200,
      "GRAPH_DEACTIVATE",
    );

    await expectJson(
      await request(`${graphPath}/edges/${edgeId}`, "DELETE", cookie),
      200,
      "EDGE_DELETE",
    );
    await expectJson(
      await request(`${graphPath}/nodes/${actionId}`, "DELETE", cookie),
      200,
      "ACTION_DELETE",
    );
    await expectJson(await request(graphPath, "DELETE", cookie), 200, "GRAPH_ARCHIVE");
    automationId = undefined;
    await expectJson(await request(graphPath, "GET", cookie), 404, "ARCHIVED_GRAPH_HIDDEN");

    // Exercise the durable sleep path separately after the immediate task action.
    const workflowGraph = await expectJson(
      await request(base, "POST", cookie, { name: `Workflow smoke ${suffix}` }),
      201,
      "WORKFLOW_GRAPH_CREATE",
    );
    automationId = stringField(workflowGraph.data, "id");
    const workflowPath = `${base}/${automationId}`;
    const workflowTrigger = await expectJson(
      await request(`${workflowPath}/nodes`, "POST", cookie, {
        kind: "trigger",
        type: "task_created",
        config: {},
        pos_x: 0,
        pos_y: 0,
      }),
      201,
      "WORKFLOW_TRIGGER_CREATE",
    );
    const workflowWait = await expectJson(
      await request(`${workflowPath}/nodes`, "POST", cookie, {
        kind: "action",
        type: "wait",
        config: { wait_minutes: 1 },
        pos_x: 200,
        pos_y: 0,
      }),
      201,
      "WORKFLOW_WAIT_CREATE",
    );
    const workflowWaitId = stringField(workflowWait.data, "id");
    await expectJson(
      await request(`${workflowPath}/edges`, "POST", cookie, {
        source_node_id: stringField(workflowTrigger.data, "id"),
        target_node_id: workflowWaitId,
      }),
      201,
      "WORKFLOW_EDGE_CREATE",
    );
    await expectJson(
      await request(`${workflowPath}/activate`, "POST", cookie),
      200,
      "WORKFLOW_GRAPH_ACTIVATE",
    );
    const task = await expectJson(
      await request(`/api/v1/projects/${projectId}/tasks`, "POST", cookie, {
        title: `Workflow task ${suffix}`,
      }),
      201,
      "WORKFLOW_TASK_CREATE",
    );
    const taskId = stringField(task.data, "id");
    const completedRunId = await waitForCompletedRun(workflowPath, cookie, taskId);
    const steps = await expectJson(
      await request(`${workflowPath}/runs/${completedRunId}/steps`, "GET", cookie),
      200,
      "WORKFLOW_RUN_STEPS",
    );
    const stepItems = record(steps.data)?.items;
    if (
      !Array.isArray(stepItems) ||
      stepItems.length !== 1 ||
      record(stepItems[0])?.node_id !== workflowWaitId ||
      record(stepItems[0])?.status !== "completed"
    ) {
      throw new Error("AUTOMATION_SMOKE_WORKFLOW_STEP_INVALID");
    }
    await expectJson(
      await request(`${workflowPath}/deactivate`, "POST", cookie),
      200,
      "WORKFLOW_GRAPH_DEACTIVATE",
    );
    await expectJson(await request(workflowPath, "DELETE", cookie), 200, "WORKFLOW_GRAPH_ARCHIVE");
    automationId = undefined;

    smokeCompleted = true;
  } finally {
    const cleanupFailures: string[] = [];
    if (cookie && projectId) {
      if (automationId) {
        const graphCleanup = await request(
          `/api/v1/projects/${projectId}/automations/${automationId}`,
          "DELETE",
          cookie,
        ).catch(() => null);
        if (!graphCleanup || ![200, 404].includes(graphCleanup.status)) {
          cleanupFailures.push("GRAPH_ARCHIVE_FAILED");
        }
      }
      const projectCleanup = await request(`/api/v1/projects/${projectId}`, "DELETE", cookie).catch(
        () => null,
      );
      if (!projectCleanup || projectCleanup.status !== 200) {
        cleanupFailures.push("PROJECT_ARCHIVE_FAILED");
      }
    }
    if (cookie) {
      const signOut = await request("/api/auth/sign-out", "POST", cookie, {}).catch(() => null);
      if (!signOut || signOut.status !== 200) cleanupFailures.push("SIGN_OUT_FAILED");
    }
    if (userId) {
      try {
        await client.query("BEGIN");
        if (projectId) {
          const deletedProject = await client.query(
            "DELETE FROM paca_project WHERE id = $1 AND name = $2 AND created_by = $3",
            [projectId, projectName, userId],
          );
          if (deletedProject.rowCount !== 1) cleanupFailures.push("PROJECT_DELETE_FAILED");
        }
        await client.query("DELETE FROM paca_organization_role WHERE id = $1", [testRoleId]);
        const deletedUser = await client.query('DELETE FROM "user" WHERE id = $1 AND email = $2', [
          userId,
          email,
        ]);
        if (deletedUser.rowCount !== 1) cleanupFailures.push("USER_DELETE_FAILED");
        await client.query("COMMIT");
      } catch {
        await client.query("ROLLBACK").catch(() => undefined);
        cleanupFailures.push("DATABASE_CLEANUP_FAILED");
      }
    }
    await client.end().catch(() => cleanupFailures.push("DATABASE_DISCONNECT_FAILED"));
    await pscale(["role", "delete", database, branch, role.id, "--force"]).catch(() =>
      cleanupFailures.push("TEMP_ROLE_DELETE_FAILED"),
    );
    if (cleanupFailures.length > 0) {
      cleanupFailure = cleanupFailures.join("_");
      if (!smokeCompleted) {
        console.error(
          JSON.stringify({ status: "error", step: "automation-cleanup", cleanupFailures }),
        );
      }
    }
  }
  if (cleanupFailure) throw new Error(cleanupFailure);
  console.log(JSON.stringify({ status: "ok", step: "automation-internal-smoke", graphCrud: true }));
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      status: "error",
      step: "automation-internal-smoke",
      code: error instanceof Error ? error.message : "UNKNOWN_ERROR",
    }),
  );
  process.exitCode = 1;
});
