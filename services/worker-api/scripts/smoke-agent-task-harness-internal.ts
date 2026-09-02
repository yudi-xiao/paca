import { fileURLToPath } from "node:url";

import {
  type DelegatedAgentConfig,
  executeAgentCapability,
  readAgentHostConfig,
  registerDelegatedAgentWithCapabilities,
} from "../src/agent-auth/agent-client";
import { AgentHostEnrollmentError } from "../src/agent-auth/host-enrollment";
import {
  AgentTaskHarnessClient,
  delegatedAgentTaskHarnessTransport,
} from "../src/agent-task/harness-client";

type JsonRecord = Record<string, unknown>;
type HeadersWithSetCookie = Headers & { getSetCookie?: () => string[] };

const root = new URL("../../../", import.meta.url);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

async function jsonOrNull(response: Response): Promise<unknown> {
  return (response.headers.get("content-type") ?? "").includes("application/json")
    ? response.json().catch(() => null)
    : null;
}

function responseCode(body: unknown, fallback: string): string {
  const record = asRecord(body);
  const value = record?.error_code ?? record?.code ?? record?.error ?? record?.message;
  return typeof value === "string" ? value : fallback;
}

function sessionCookie(response: Response): string {
  const headers = response.headers as HeadersWithSetCookie;
  const values = headers.getSetCookie?.() ?? [headers.get("set-cookie") ?? ""];
  for (const value of values) {
    const match = value.match(/(?:^|,\s*)([^=;,\s]*session_token)=([^;,\s]+)/i);
    if (match?.[1] && match[2]) return `${match[1]}=${match[2]}`;
  }
  throw new Error("SESSION_COOKIE_MISSING");
}

async function userRequest(
  baseURL: string,
  path: string,
  cookie: string,
  method: string,
  body?: JsonRecord,
): Promise<{ response: Response; body: unknown }> {
  const headers = new Headers({ origin: baseURL });
  if (cookie) headers.set("cookie", cookie);
  if (body) headers.set("content-type", "application/json");
  const response = await fetch(`${baseURL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  return { response, body: await jsonOrNull(response) };
}

function requireStatus(response: Response, expected: number, body: unknown, step: string): void {
  if (response.status !== expected) {
    throw new Error(responseCode(body, `${step}_HTTP_${response.status}`));
  }
}

function requireData(value: unknown, step: string): JsonRecord {
  const record = asRecord(value);
  const data = asRecord(record?.data) ?? record;
  if (!data) throw new Error(`${step}_DATA_INVALID`);
  return data;
}

function leaseResult(
  value: unknown,
  step: string,
): {
  duplicate: boolean;
  lease: JsonRecord;
} {
  const result = requireData(value, step);
  const lease = asRecord(result.lease);
  if (typeof result.duplicate !== "boolean" || !lease || typeof lease.id !== "string") {
    throw new Error(`${step}_RESULT_INVALID`);
  }
  return { duplicate: result.duplicate, lease };
}

async function expectAgentFailure(
  operation: () => Promise<unknown>,
  step: string,
): Promise<string> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof AgentHostEnrollmentError) return error.code;
    if (error instanceof Error) return error.message;
    return "UNKNOWN_ERROR";
  }
  throw new Error(`${step}_NOT_REJECTED`);
}

async function execute(config: DelegatedAgentConfig, arguments_: JsonRecord): Promise<unknown> {
  return executeAgentCapability({
    config,
    capability: "task.execute",
    arguments: arguments_,
  });
}

async function main(): Promise<void> {
  const baseURL = new URL(
    process.env.PACA_INTERNAL_BASE_URL?.trim() || "https://paca.howlearnwood.com",
  ).origin;
  const organizationId = process.env.PACA_ORGANIZATION_ID?.trim() || "paca-default";
  const projectId = required("PACA_PROJECT_ID");
  const hostConfigPath =
    process.env.PACA_AGENT_HOST_CONFIG?.trim() ||
    fileURLToPath(new URL(".paca/agent-host.json", root));
  const signIn = await userRequest(baseURL, "/api/auth/sign-in/email", "", "POST", {
    email: required("PACA_APPROVER_EMAIL"),
    password: required("PACA_APPROVER_PASSWORD"),
    rememberMe: false,
  });
  requireStatus(signIn.response, 200, signIn.body, "SIGN_IN");
  const cookie = sessionCookie(signIn.response);
  const runSuffix = crypto.randomUUID().slice(0, 8);
  let taskId: string | null = null;
  let agentId: string | null = null;
  let grantActive = false;

  try {
    const created = await userRequest(
      baseURL,
      `/api/v1/projects/${projectId}/tasks`,
      cookie,
      "POST",
      { title: `Local Harness lease smoke ${runSuffix}` },
    );
    requireStatus(created.response, 201, created.body, "CREATE_TASK");
    const task = requireData(created.body, "CREATE_TASK");
    if (typeof task.id !== "string") throw new Error("CREATE_TASK_ID_INVALID");
    taskId = task.id;

    const validUntil = new Date(Date.now() + 10 * 60_000).toISOString();
    const hostConfig = await readAgentHostConfig(hostConfigPath);
    const registration = await registerDelegatedAgentWithCapabilities({
      hostConfig,
      agentName: `Local Codex Harness smoke ${runSuffix}`,
      capabilityRequests: [
        {
          capability: "task.execute",
          constraints: {
            organizationId,
            projectId,
            taskId,
            operationMode: "execute",
            action: {
              in: ["claim", "renew", "checkpoint", "complete", "fail", "cancel_ack"],
            },
            validUntil,
          },
        },
      ],
      reason: "验证本地 Codex Harness 的任务领取、续租、checkpoint 与提交协议。",
      bindingMessage: "仅限临时 smoke 工作项和十分钟短期 task.execute Grant。",
    });
    agentId = registration.config.agentId;
    const approval = await userRequest(
      baseURL,
      "/api/auth/agent/approve-capability",
      cookie,
      "POST",
      {
        agent_id: agentId,
        user_code: registration.approval.userCode,
        action: "approve",
      },
    );
    requireStatus(approval.response, 200, approval.body, "APPROVE_AGENT");
    if (asRecord(approval.body)?.status !== "approved") {
      throw new Error("APPROVE_AGENT_RESPONSE_INVALID");
    }
    grantActive = true;

    const harnessClient = new AgentTaskHarnessClient(
      delegatedAgentTaskHarnessTransport(registration.config),
      { kind: "codex", version: "smoke", instanceId: `local-${runSuffix}` },
    );
    const discoveredBeforeClaim = await harnessClient.discover();
    if (
      discoveredBeforeClaim.length !== 1 ||
      discoveredBeforeClaim[0]?.task_id !== taskId ||
      discoveredBeforeClaim[0]?.availability !== "claimable"
    ) {
      throw new Error("DISCOVERY_CLAIMABLE_INVALID");
    }

    const scope = {
      organizationId,
      projectId,
      taskId,
      operationMode: "execute",
      validUntil,
    };
    const claimRequestId = crypto.randomUUID();
    const claim = {
      ...scope,
      requestId: claimRequestId,
      action: "claim",
      leaseDurationMs: 60_000,
      harness: { kind: "codex", version: "smoke", instanceId: `local-${runSuffix}` },
    };
    const claimed = leaseResult(await execute(registration.config, claim), "CLAIM");
    if (claimed.duplicate || claimed.lease.status !== "active") {
      throw new Error("CLAIM_STATE_INVALID");
    }
    const leaseId = claimed.lease.id as string;
    const discoveredOwned = await harnessClient.discover();
    if (
      discoveredOwned.length !== 1 ||
      discoveredOwned[0]?.availability !== "owned" ||
      discoveredOwned[0]?.lease?.id !== leaseId
    ) {
      throw new Error("DISCOVERY_OWNED_INVALID");
    }

    const duplicateClaim = leaseResult(
      await execute(registration.config, claim),
      "DUPLICATE_CLAIM",
    );
    if (!duplicateClaim.duplicate || duplicateClaim.lease.id !== leaseId) {
      throw new Error("DUPLICATE_CLAIM_RESULT_INVALID");
    }
    const changedRetryCode = await expectAgentFailure(
      () => execute(registration.config, { ...claim, leaseDurationMs: 65_000 }),
      "CHANGED_CLAIM_RETRY",
    );
    const competingClaimCode = await expectAgentFailure(
      () => execute(registration.config, { ...claim, requestId: crypto.randomUUID() }),
      "COMPETING_CLAIM",
    );

    const renewed = leaseResult(
      await execute(registration.config, {
        ...scope,
        leaseId,
        requestId: crypto.randomUUID(),
        action: "renew",
        leaseDurationMs: 90_000,
      }),
      "RENEW",
    );
    if (renewed.lease.version !== 2) throw new Error("RENEW_VERSION_INVALID");

    const checkpoint = {
      ...scope,
      leaseId,
      requestId: crypto.randomUUID(),
      action: "checkpoint",
      sequence: 1,
      checkpointKey: `agent-task/${leaseId}/1.json`,
      summary: "local harness checkpoint",
      artifactKeys: [],
    };
    const checkpointed = leaseResult(await execute(registration.config, checkpoint), "CHECKPOINT");
    if (checkpointed.lease.lastCheckpointSequence !== 1) {
      throw new Error("CHECKPOINT_SEQUENCE_INVALID");
    }
    const duplicateCheckpoint = leaseResult(
      await execute(registration.config, checkpoint),
      "DUPLICATE_CHECKPOINT",
    );
    if (!duplicateCheckpoint.duplicate) throw new Error("CHECKPOINT_NOT_IDEMPOTENT");
    const skippedCheckpointCode = await expectAgentFailure(
      () =>
        execute(registration.config, {
          ...checkpoint,
          requestId: crypto.randomUUID(),
          sequence: 3,
        }),
      "SKIPPED_CHECKPOINT",
    );

    const completed = leaseResult(
      await execute(registration.config, {
        ...scope,
        leaseId,
        requestId: crypto.randomUUID(),
        action: "complete",
        summary: "local harness completed the smoke task",
        artifactKeys: [],
      }),
      "COMPLETE",
    );
    if (completed.lease.status !== "completed" || completed.lease.version !== 4) {
      throw new Error("COMPLETE_STATE_INVALID");
    }

    const revoke = await userRequest(
      baseURL,
      "/api/auth/paca-agent/revoke-capability",
      cookie,
      "POST",
      { agent_id: agentId, capabilities: ["task.execute"] },
    );
    requireStatus(revoke.response, 200, revoke.body, "REVOKE_CAPABILITY");
    grantActive = false;
    const revokedExecutionCode = await expectAgentFailure(
      () =>
        execute(registration.config, {
          ...scope,
          leaseId,
          requestId: crypto.randomUUID(),
          action: "renew",
          leaseDurationMs: 60_000,
        }),
      "REVOKED_EXECUTION",
    );

    console.log(
      JSON.stringify({
        status: "ok",
        step: "agent-task-harness-smoke",
        projectId,
        taskId,
        agentId,
        harness: "codex",
        leaseId,
        finalStatus: completed.lease.status,
        finalVersion: completed.lease.version,
        duplicateClaim: true,
        duplicateCheckpoint: true,
        discoveryClaimable: true,
        discoveryOwned: true,
        changedRetryCode,
        competingClaimCode,
        skippedCheckpointCode,
        revokedExecutionCode,
      }),
    );
  } finally {
    if (agentId && grantActive) {
      await userRequest(baseURL, "/api/auth/paca-agent/revoke-capability", cookie, "POST", {
        agent_id: agentId,
        capabilities: ["task.execute"],
      }).catch(() => null);
    }
    if (agentId) {
      await userRequest(baseURL, "/api/auth/agent/revoke", cookie, "POST", {
        agent_id: agentId,
      }).catch(() => null);
    }
    if (taskId) {
      await userRequest(
        baseURL,
        `/api/v1/projects/${projectId}/tasks/${taskId}`,
        cookie,
        "DELETE",
      ).catch(() => null);
    }
    await userRequest(baseURL, "/api/auth/sign-out", cookie, "POST", {}).catch(() => null);
  }
}

main().catch((error: unknown) => {
  const code =
    error instanceof AgentHostEnrollmentError
      ? error.code
      : error instanceof Error
        ? error.message
        : "UNKNOWN_ERROR";
  console.error(JSON.stringify({ status: "error", step: "agent-task-harness-smoke", code }));
  process.exitCode = 1;
});
