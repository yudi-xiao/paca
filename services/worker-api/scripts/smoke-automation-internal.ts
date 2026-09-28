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
    const projectMembership = await client.query<{ id: string }>(
      "SELECT id FROM paca_project_member WHERE project_id = $1 AND user_id = $2",
      [projectId, userId],
    );
    const projectMemberId = projectMembership.rows[0]?.id;
    if (!projectMemberId) throw new Error("AUTOMATION_SMOKE_PROJECT_MEMBER_MISSING");
    const base = `/api/v1/projects/${projectId}/automations`;
    const taskBase = `/api/v1/projects/${projectId}/tasks`;
    for (const fieldKey of ["existing", "release"]) {
      await expectJson(
        await request(`/api/v1/projects/${projectId}/custom-fields`, "POST", cookie, {
          field_key: fieldKey,
          display_name: fieldKey,
          field_type: "text",
        }),
        201,
        "CUSTOM_FIELD_CREATE",
      );
    }

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
        config: {
          update: {
            importance: 1,
            assignee_ids: [projectMemberId],
            reporter_id: projectMemberId,
            custom_fields: { release: "v2" },
            start_date: "2026-09-28T00:00:00Z",
            due_date: "2026-10-01T00:00:00Z",
          },
        },
        pos_x: 200,
        pos_y: 0,
      }),
      201,
      "ACTION_CREATE",
    );
    const condition = await expectJson(
      await request(`${graphPath}/nodes`, "POST", cookie, {
        kind: "condition",
        type: "condition",
        config: {
          branches: [
            {
              handle: "zero",
              tree: { field: "importance", operator: "equals", value: "0" },
            },
          ],
        },
        pos_x: 100,
        pos_y: 0,
      }),
      201,
      "CONDITION_CREATE",
    );
    const triggerId = stringField(trigger.data, "id");
    const actionId = stringField(action.data, "id");
    const conditionId = stringField(condition.data, "id");
    const edge = await expectJson(
      await request(`${graphPath}/edges`, "POST", cookie, {
        source_node_id: triggerId,
        target_node_id: conditionId,
      }),
      201,
      "EDGE_CREATE",
    );
    const edgeId = stringField(edge.data, "id");
    const branchEdge = await expectJson(
      await request(`${graphPath}/edges`, "POST", cookie, {
        source_node_id: conditionId,
        source_handle: "zero",
        target_node_id: actionId,
      }),
      201,
      "BRANCH_EDGE_CREATE",
    );
    const branchEdgeId = stringField(branchEdge.data, "id");

    const graph = await expectJson(await request(graphPath, "GET", cookie), 200, "GRAPH_READ");
    const graphData = record(graph.data);
    if (
      record(graphData?.automation)?.id !== automationId ||
      !Array.isArray(graphData?.nodes) ||
      graphData.nodes.length !== 3 ||
      !Array.isArray(graphData?.edges) ||
      graphData.edges.length !== 2
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
        custom_fields: { existing: "keep" },
      }),
      201,
      "ACTION_TASK_CREATE",
    );
    const actionTaskId = stringField(actionTask.data, "id");
    const actionRunId = await waitForCompletedRun(graphPath, cookie, actionTaskId);
    const actionSteps = await expectJson(
      await request(`${graphPath}/runs/${actionRunId}/steps`, "GET", cookie),
      200,
      "ACTION_RUN_STEPS",
    );
    const actionStepItems = record(actionSteps.data)?.items;
    if (
      !Array.isArray(actionStepItems) ||
      !actionStepItems.some(
        (step) =>
          record(step)?.node_id === conditionId &&
          record(record(step)?.output_snapshot)?.matched_handle === "zero",
      ) ||
      !actionStepItems.some((step) => record(step)?.node_id === actionId)
    ) {
      throw new Error("AUTOMATION_SMOKE_CONDITION_MATCH_INVALID");
    }
    const updatedTask = await expectJson(
      await request(`/api/v1/projects/${projectId}/tasks/${actionTaskId}`, "GET", cookie),
      200,
      "ACTION_TASK_READ",
    );
    if (
      record(updatedTask.data)?.importance !== 1 ||
      record(updatedTask.data)?.start_date !== "2026-09-28" ||
      record(updatedTask.data)?.due_date !== "2026-10-01" ||
      record(updatedTask.data)?.reporter_id !== projectMemberId ||
      record(record(updatedTask.data)?.custom_fields)?.existing !== "keep" ||
      record(record(updatedTask.data)?.custom_fields)?.release !== "v2" ||
      !Array.isArray(record(updatedTask.data)?.assignee_ids) ||
      !(record(updatedTask.data)?.assignee_ids as unknown[]).includes(projectMemberId)
    ) {
      throw new Error("AUTOMATION_SMOKE_TASK_NOT_UPDATED");
    }
    const notification = await client.query<{ actor_type: string; recipient_user_id: string }>(
      "SELECT actor_type, recipient_user_id FROM paca_notification WHERE task_id = $1 AND type = 'assigned'",
      [actionTaskId],
    );
    if (
      notification.rows.length !== 1 ||
      notification.rows[0]?.actor_type !== "system" ||
      notification.rows[0]?.recipient_user_id !== userId
    ) {
      throw new Error("AUTOMATION_SMOKE_ASSIGNMENT_NOTIFICATION_INVALID");
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
    const skippedTask = await expectJson(
      await request(`/api/v1/projects/${projectId}/tasks`, "POST", cookie, {
        title: `Skipped task ${suffix}`,
        importance: 2,
      }),
      201,
      "SKIPPED_TASK_CREATE",
    );
    const skippedTaskId = stringField(skippedTask.data, "id");
    const skippedRunId = await waitForCompletedRun(graphPath, cookie, skippedTaskId);
    const skippedSteps = await expectJson(
      await request(`${graphPath}/runs/${skippedRunId}/steps`, "GET", cookie),
      200,
      "SKIPPED_RUN_STEPS",
    );
    const skippedItems = record(skippedSteps.data)?.items;
    if (
      !Array.isArray(skippedItems) ||
      skippedItems.length !== 1 ||
      record(skippedItems[0])?.node_id !== conditionId ||
      record(record(skippedItems[0])?.output_snapshot)?.matched_handle !== "else"
    ) {
      throw new Error("AUTOMATION_SMOKE_CONDITION_ELSE_INVALID");
    }
    const untouchedTask = await expectJson(
      await request(`/api/v1/projects/${projectId}/tasks/${skippedTaskId}`, "GET", cookie),
      200,
      "SKIPPED_TASK_READ",
    );
    if (record(untouchedTask.data)?.importance !== 2) {
      throw new Error("AUTOMATION_SMOKE_ELSE_MUTATED_TASK");
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
      await request(`${graphPath}/edges/${branchEdgeId}`, "DELETE", cookie),
      200,
      "BRANCH_EDGE_DELETE",
    );
    await expectJson(
      await request(`${graphPath}/nodes/${actionId}`, "DELETE", cookie),
      200,
      "ACTION_DELETE",
    );
    await expectJson(
      await request(`${graphPath}/nodes/${conditionId}`, "DELETE", cookie),
      200,
      "CONDITION_DELETE",
    );
    await expectJson(await request(graphPath, "DELETE", cookie), 200, "GRAPH_ARCHIVE");
    automationId = undefined;
    await expectJson(await request(graphPath, "GET", cookie), 404, "ARCHIVED_GRAPH_HIDDEN");

    const statuses = await client.query<{ id: string }>(
      "SELECT id FROM paca_task_status WHERE project_id = $1 AND name = 'To Do'",
      [projectId],
    );
    const nextStatusId = statuses.rows[0]?.id;
    if (!nextStatusId) throw new Error("AUTOMATION_SMOKE_STATUS_MISSING");
    const parentTask = await expectJson(
      await request(taskBase, "POST", cookie, { title: `Fanout parent ${suffix}` }),
      201,
      "FANOUT_PARENT_CREATE",
    );
    const parentTaskId = stringField(parentTask.data, "id");
    const childTaskIds: string[] = [];
    for (const index of [1, 2]) {
      const child = await expectJson(
        await request(taskBase, "POST", cookie, {
          title: `Fanout child ${index} ${suffix}`,
          parent_task_id: parentTaskId,
          custom_fields: { existing: `child-${index}` },
        }),
        201,
        "FANOUT_CHILD_CREATE",
      );
      childTaskIds.push(stringField(child.data, "id"));
    }
    const fanoutGraph = await expectJson(
      await request(base, "POST", cookie, { name: `Fanout ${suffix}` }),
      201,
      "FANOUT_GRAPH_CREATE",
    );
    automationId = stringField(fanoutGraph.data, "id");
    const fanoutPath = `${base}/${automationId}`;
    const fanoutTrigger = await expectJson(
      await request(`${fanoutPath}/nodes`, "POST", cookie, {
        kind: "trigger",
        type: "status_changed",
        config: { status_id: nextStatusId },
        pos_x: 0,
        pos_y: 0,
      }),
      201,
      "FANOUT_TRIGGER_CREATE",
    );
    const fanoutAction = await expectJson(
      await request(`${fanoutPath}/nodes`, "POST", cookie, {
        kind: "action",
        type: "update_task",
        config: {
          target: { kind: "children" },
          update: { custom_fields: { release: "fanout" } },
        },
        pos_x: 200,
        pos_y: 0,
      }),
      201,
      "FANOUT_ACTION_CREATE",
    );
    const fanoutActionId = stringField(fanoutAction.data, "id");
    await expectJson(
      await request(`${fanoutPath}/edges`, "POST", cookie, {
        source_node_id: stringField(fanoutTrigger.data, "id"),
        target_node_id: fanoutActionId,
      }),
      201,
      "FANOUT_EDGE_CREATE",
    );
    await expectJson(
      await request(`${fanoutPath}/activate`, "POST", cookie),
      200,
      "FANOUT_ACTIVATE",
    );
    await expectJson(
      await request(`${taskBase}/${parentTaskId}`, "PATCH", cookie, {
        status_id: nextStatusId,
      }),
      200,
      "FANOUT_STATUS_CHANGE",
    );
    const fanoutRunId = await waitForCompletedRun(fanoutPath, cookie, parentTaskId);
    const fanoutSteps = await expectJson(
      await request(`${fanoutPath}/runs/${fanoutRunId}/steps`, "GET", cookie),
      200,
      "FANOUT_RUN_STEPS",
    );
    const fanoutStep = (record(fanoutSteps.data)?.items as unknown[] | undefined)
      ?.map(record)
      .find((step) => step?.node_id === fanoutActionId);
    const fanoutOutput = record(fanoutStep?.output_snapshot);
    const fanoutTaskIds = fanoutOutput?.task_ids;
    if (
      !Array.isArray(fanoutTaskIds) ||
      fanoutTaskIds.length !== childTaskIds.length ||
      !childTaskIds.every((id) => fanoutTaskIds.includes(id))
    ) {
      throw new Error("AUTOMATION_SMOKE_FANOUT_TARGETS_INVALID");
    }
    for (const childTaskId of childTaskIds) {
      const child = await expectJson(
        await request(`${taskBase}/${childTaskId}`, "GET", cookie),
        200,
        "FANOUT_CHILD_READ",
      );
      if (record(record(child.data)?.custom_fields)?.release !== "fanout") {
        throw new Error("AUTOMATION_SMOKE_FANOUT_CHILD_NOT_UPDATED");
      }
    }
    const fanoutAudit = await client.query<{ task_id: string; count: string }>(
      "SELECT task_id, count(*)::text AS count FROM paca_task_activity WHERE task_id = ANY($1::uuid[]) AND activity_type = 'task.updated' GROUP BY task_id",
      [childTaskIds],
    );
    if (
      fanoutAudit.rows.length !== childTaskIds.length ||
      fanoutAudit.rows.some((row) => row.count !== "1")
    ) {
      throw new Error("AUTOMATION_SMOKE_FANOUT_AUDIT_INVALID");
    }
    await expectJson(
      await request(`${fanoutPath}/deactivate`, "POST", cookie),
      200,
      "FANOUT_DEACTIVATE",
    );
    await expectJson(await request(fanoutPath, "DELETE", cookie), 200, "FANOUT_ARCHIVE");
    automationId = undefined;

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
