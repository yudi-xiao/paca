import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  executeAgentCapability,
  readAgentHostConfig,
  registerDelegatedAgentWithCapabilities,
} from "../src/agent-auth/agent-client";

type JsonRecord = Record<string, unknown>;
type HeadersWithSetCookie = Headers & { getSetCookie?: () => string[] };
type EnvironmentOperationMode = "read" | "execute";
type RevocationMode = "environment-archive" | "grant" | "project-permission";

const TERMINAL_READY_TIMEOUT_MS = 90_000;
const PROVIDER_ACTION_MAX_ATTEMPTS = 3;
const PROVIDER_ACTION_TIMEOUT_MS = 90_000;

const execFileAsync = promisify(execFile);
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

function responseCode(body: unknown, fallback: string): string {
  const record = asRecord(body);
  const value = record?.error_code ?? record?.code ?? record?.error ?? record?.message;
  return typeof value === "string" ? value : fallback;
}

async function jsonOrNull(response: Response): Promise<unknown> {
  return (response.headers.get("content-type") ?? "").includes("application/json")
    ? response.json().catch(() => null)
    : null;
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
    signal: AbortSignal.timeout(20_000),
  });
  return { response, body: await jsonOrNull(response) };
}

function requireStatus(response: Response, expected: number, body: unknown, step: string): void {
  if (response.status !== expected) {
    throw new Error(responseCode(body, `${step}_HTTP_${response.status}`));
  }
}

function redact(value: string): string {
  return value
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s/]+@/giu, "$1[REDACTED]@")
    .replace(/("password"\s*:\s*")[^"]+/giu, "$1[REDACTED]")
    .slice(0, 4_000);
}

async function command(executable: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync(executable, args, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    throw new Error(
      `${executable.toUpperCase()}_FAILED: ${redact(failure.stderr || failure.stdout || failure.message)}`,
    );
  }
}

async function pscale(organization: string, args: string[]): Promise<string> {
  return command("pscale", [...args, "--org", organization, "--format", "json"]);
}

async function createTemporaryDatabaseRole(organization: string): Promise<{
  id: string;
  databaseURL: string;
}> {
  const payload = asRecord(
    JSON.parse(
      await pscale(organization, [
        "role",
        "create",
        "paca",
        "internal",
        `paca-environment-smoke-${Date.now()}`,
        "--inherited-roles",
        "postgres",
        "--ttl",
        "15m",
      ]),
    ) as unknown,
  );
  if (typeof payload?.id !== "string" || typeof payload.database_url !== "string") {
    throw new Error("TEMP_DATABASE_ROLE_INVALID");
  }
  const databaseURL = new URL(payload.database_url);
  if (!databaseURL.password && typeof payload.password === "string") {
    databaseURL.password = payload.password;
  }
  if (!databaseURL.password) throw new Error("TEMP_DATABASE_ROLE_PASSWORD_MISSING");
  databaseURL.searchParams.set("sslmode", "verify-full");
  databaseURL.searchParams.set("sslrootcert", "system");
  return { id: payload.id, databaseURL: databaseURL.toString() };
}

async function deleteTemporaryDatabaseRole(organization: string, roleId: string): Promise<void> {
  await pscale(organization, [
    "role",
    "delete",
    "paca",
    "internal",
    roleId,
    "--successor",
    "postgres",
    "--force",
  ]);
}

async function query(databaseURL: string, sql: string): Promise<void> {
  const args = ["--dbname", databaseURL, "--no-psqlrc", "--set", "ON_ERROR_STOP=1"];
  args.push("--command", sql);
  await command("psql", args);
}

async function websocketText(value: unknown): Promise<string> {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }
  if (value instanceof Blob) return value.text();
  return "";
}

async function openVerifiedTerminal(url: string, accessToken: string): Promise<WebSocket> {
  const marker = `PACA_TERMINAL_SMOKE_${crypto.randomUUID().replaceAll("-", "")}`;
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, [`paca-ticket.${accessToken}`]);
    socket.binaryType = "arraybuffer";
    let settled = false;
    let ready = false;
    let output = "";
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.close(1000, "smoke timeout");
      reject(
        new Error(ready ? "SANDBOX_TERMINAL_OUTPUT_TIMEOUT" : "SANDBOX_TERMINAL_READY_TIMEOUT"),
      );
    }, TERMINAL_READY_TIMEOUT_MS);
    const succeed = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(socket);
    };
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        try {
          const control = asRecord(JSON.parse(event.data) as unknown);
          if (control?.type === "ready" && !ready) {
            ready = true;
            socket.send(JSON.stringify({ type: "resize", cols: 120, rows: 30 }));
            socket.send(new TextEncoder().encode(`printf '${marker}\\n'\n`));
          } else if (control?.type === "error") {
            settled = true;
            clearTimeout(timeout);
            socket.close(1000, "terminal error");
            reject(new Error("SANDBOX_TERMINAL_PROTOCOL_ERROR"));
          }
        } catch {
          // Unknown text frames are not terminal output and are intentionally ignored.
        }
        return;
      }
      void websocketText(event.data)
        .then((chunk) => {
          output = `${output}${chunk}`.slice(-16_384);
          if (output.includes(marker)) succeed();
        })
        .catch(() => undefined);
    });
    socket.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error("SANDBOX_TERMINAL_CONNECTION_FAILED"));
    });
    socket.addEventListener("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error("SANDBOX_TERMINAL_CLOSED_EARLY"));
    });
  });
}

async function verifyTicketRejected(
  url: string,
  accessToken: string,
  acceptedErrorCode: string,
): Promise<boolean> {
  const replayRejected = await new Promise<boolean>((resolve) => {
    const socket = new WebSocket(url, [`paca-ticket.${accessToken}`]);
    let opened = false;
    const timeout = setTimeout(() => {
      socket.close(1000, "replay smoke timeout");
      resolve(!opened);
    }, 10_000);
    socket.addEventListener("open", () => {
      opened = true;
      clearTimeout(timeout);
      socket.close(1000, "unexpected replay");
      resolve(false);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      resolve(!opened);
    });
    socket.addEventListener("close", () => {
      clearTimeout(timeout);
      resolve(!opened);
    });
  });
  if (!replayRejected) throw new Error(acceptedErrorCode);
  return replayRejected;
}

async function waitForTerminalRevocation(socket: WebSocket): Promise<boolean> {
  if (socket.readyState === WebSocket.CLOSED) return true;
  return new Promise<boolean>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close(1000, "revocation smoke timeout");
      reject(new Error("SANDBOX_TERMINAL_REVOCATION_TIMEOUT"));
    }, 20_000);
    socket.addEventListener(
      "close",
      () => {
        clearTimeout(timeout);
        resolve(true);
      },
      { once: true },
    );
  });
}

async function providerActionWithRetry(
  connection: { url: string; accessToken: string },
  action: "prepare" | "status",
): Promise<{
  body: unknown;
  clientAttempts: number;
  providerAttempts: number;
  durationMs: number;
}> {
  const endpoint = connection.url.replace(/^wss:/u, "https:");
  const startedAt = Date.now();
  let providerAttempts = 0;
  for (
    let clientAttempts = 1;
    clientAttempts <= PROVIDER_ACTION_MAX_ATTEMPTS;
    clientAttempts += 1
  ) {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${connection.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action }),
        redirect: "error",
        signal: AbortSignal.timeout(PROVIDER_ACTION_TIMEOUT_MS),
      });
    } catch {
      if (clientAttempts === PROVIDER_ACTION_MAX_ATTEMPTS) {
        throw new Error("SANDBOX_PROVIDER_ACTION_UNAVAILABLE");
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    const attemptsHeader = Number(response.headers.get("x-paca-provider-attempts") ?? 0);
    if (Number.isSafeInteger(attemptsHeader) && attemptsHeader > 0 && attemptsHeader <= 3) {
      providerAttempts += attemptsHeader;
    }
    const body = await jsonOrNull(response);
    if (response.ok) {
      return {
        body,
        clientAttempts,
        providerAttempts: Math.max(providerAttempts, 1),
        durationMs: Date.now() - startedAt,
      };
    }
    const failure = asRecord(body);
    const retryAfterMs = failure?.retryAfterMs;
    if (
      response.status !== 503 ||
      failure?.retryable !== true ||
      clientAttempts === PROVIDER_ACTION_MAX_ATTEMPTS
    ) {
      throw new Error(responseCode(body, `SANDBOX_PROVIDER_ACTION_HTTP_${response.status}`));
    }
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        typeof retryAfterMs === "number" &&
          Number.isSafeInteger(retryAfterMs) &&
          retryAfterMs >= 100 &&
          retryAfterMs <= 5_000
          ? retryAfterMs
          : 500,
      ),
    );
  }
  throw new Error("SANDBOX_PROVIDER_RETRY_INVARIANT");
}

function uuid(value: string, code: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error(code);
  }
  return value;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function main(): Promise<void> {
  const baseURL = new URL(
    process.env.PACA_INTERNAL_BASE_URL?.trim() || "https://paca.howlearnwood.com",
  ).origin;
  const organizationId = process.env.PACA_ORGANIZATION_ID?.trim() || "paca-default";
  const projectId = uuid(required("PACA_PROJECT_ID"), "PACA_PROJECT_ID_INVALID");
  const operationMode = (process.env.PACA_ENVIRONMENT_SMOKE_MODE?.trim() ||
    "read") as EnvironmentOperationMode;
  if (operationMode !== "read" && operationMode !== "execute") {
    throw new Error("PACA_ENVIRONMENT_SMOKE_MODE_INVALID");
  }
  const revocationMode = (process.env.PACA_ENVIRONMENT_SMOKE_REVOCATION?.trim() ||
    "grant") as RevocationMode;
  if (
    revocationMode !== "environment-archive" &&
    revocationMode !== "grant" &&
    revocationMode !== "project-permission"
  ) {
    throw new Error("PACA_ENVIRONMENT_SMOKE_REVOCATION_INVALID");
  }
  if (revocationMode !== "grant" && operationMode !== "execute") {
    throw new Error("PACA_ENVIRONMENT_SMOKE_CONNECTION_REVOCATION_REQUIRES_EXECUTE");
  }
  const pscaleOrganization = required("PACA_PLANETSCALE_ORG");
  const hostConfigPath =
    process.env.PACA_AGENT_HOST_CONFIG?.trim() ||
    fileURLToPath(new URL(".paca/agent-host.json", root));
  const environmentId = crypto.randomUUID();
  const gatewayReference = `paca-env-smoke-${environmentId.slice(0, 8)}`;
  const role = await createTemporaryDatabaseRole(pscaleOrganization);
  let scopeCreated = false;
  let agentId: string | null = null;
  let grantActive = false;
  let adminCookie = "";
  let delegatedCookie = "";
  let approvalCookie = "";
  let delegatedUserId: string | null = null;
  let projectRoleId: string | null = null;
  let projectRoleName: string | null = null;
  let projectMemberId: string | null = null;
  let terminalSocket: WebSocket | null = null;

  try {
    await query(
      role.databaseURL,
      `INSERT INTO public.paca_environment_scope
         (environment_id, project_id, name, backend, gateway_reference)
       VALUES (${sqlLiteral(environmentId)}::uuid, ${sqlLiteral(projectId)}::uuid,
               ${sqlLiteral(`Smoke ${environmentId.slice(0, 8)}`)},
               'cloudflare-sandbox', ${sqlLiteral(gatewayReference)})`,
    );
    scopeCreated = true;

    const signIn = await userRequest(baseURL, "/api/auth/sign-in/email", "", "POST", {
      email: required("PACA_APPROVER_EMAIL"),
      password: required("PACA_APPROVER_PASSWORD"),
      rememberMe: false,
    });
    requireStatus(signIn.response, 200, signIn.body, "SIGN_IN");
    adminCookie = sessionCookie(signIn.response);

    if (revocationMode === "project-permission") {
      const identity = crypto.randomUUID().replaceAll("-", "");
      const signUp = await userRequest(baseURL, "/api/auth/sign-up/email", "", "POST", {
        name: `Environment smoke ${identity.slice(0, 8)}`,
        email: `paca-environment-smoke-${identity}@example.invalid`,
        password: `${crypto.randomUUID()}Aa1!`,
      });
      requireStatus(signUp.response, 200, signUp.body, "SIGN_UP_DELEGATED_USER");
      delegatedCookie = sessionCookie(signUp.response);
      const signUpUser = asRecord(asRecord(signUp.body)?.user);
      if (typeof signUpUser?.id !== "string") throw new Error("DELEGATED_USER_RESPONSE_INVALID");
      delegatedUserId = signUpUser.id;

      const roleName = `Environment smoke ${identity.slice(0, 8)}`;
      projectRoleName = roleName;
      const createRole = await userRequest(
        baseURL,
        `/api/v1/projects/${projectId}/roles`,
        adminCookie,
        "POST",
        {
          role_name: roleName,
          permissions: {
            "agents.approveGrant": true,
            "environments.read": true,
            "environments.connect": true,
          },
        },
      );
      requireStatus(createRole.response, 201, createRole.body, "CREATE_PROJECT_ROLE");
      const createdRole = asRecord(asRecord(createRole.body)?.data);
      if (typeof createdRole?.id !== "string") throw new Error("PROJECT_ROLE_RESPONSE_INVALID");
      projectRoleId = createdRole.id;

      const addMember = await userRequest(
        baseURL,
        `/api/v1/projects/${projectId}/members`,
        adminCookie,
        "POST",
        { user_id: delegatedUserId, project_role_id: projectRoleId },
      );
      requireStatus(addMember.response, 201, addMember.body, "ADD_PROJECT_MEMBER");
      const createdMember = asRecord(asRecord(addMember.body)?.data);
      if (typeof createdMember?.id !== "string") throw new Error("PROJECT_MEMBER_RESPONSE_INVALID");
      projectMemberId = createdMember.id;
      approvalCookie = delegatedCookie;
    } else {
      approvalCookie = adminCookie;
    }

    const validUntil = new Date(Date.now() + 10 * 60_000).toISOString();
    const hostConfig = await readAgentHostConfig(hostConfigPath);
    const registration = await registerDelegatedAgentWithCapabilities({
      hostConfig,
      agentName: `Local Environment Harness smoke ${environmentId.slice(0, 8)}`,
      capabilityRequests: [
        {
          capability: "environment.connect",
          constraints: {
            organizationId,
            projectId,
            environmentId,
            operationMode,
            validUntil,
          },
        },
      ],
      reason: "验证本地 Harness 经 Agent Auth 连接 Cloudflare Sandbox 环境。",
      bindingMessage: `仅限临时环境、${operationMode} 模式和十分钟短期 Grant。`,
    });
    agentId = registration.config.agentId;

    const approval = await userRequest(
      baseURL,
      "/api/auth/agent/approve-capability",
      approvalCookie,
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

    const requestId = crypto.randomUUID();
    const execution = asRecord(
      await executeAgentCapability({
        config: registration.config,
        capability: "environment.connect",
        arguments: {
          organizationId,
          projectId,
          environmentId,
          operationMode,
          requestId,
          validUntil,
        },
      }),
    );
    const connection = asRecord(execution?.data) ?? execution;
    if (
      connection?.protocolVersion !== "paca.environment.connection.v1" ||
      connection.requestId !== requestId ||
      connection.environmentId !== environmentId ||
      connection.operationMode !== operationMode ||
      connection.transport !== (operationMode === "read" ? "http" : "websocket") ||
      typeof connection.url !== "string" ||
      typeof connection.accessToken !== "string" ||
      typeof connection.expiresAt !== "string"
    ) {
      throw new Error("ENVIRONMENT_CONNECTION_INVALID");
    }

    let processCount: number | null = null;
    let providerReadiness: {
      clientAttempts: number;
      providerAttempts: number;
      durationMs: number;
    } | null = null;
    let terminalVerified: {
      markerObserved: boolean;
      replayRejected: boolean;
      preIssuedTicketRejected: boolean;
      revocationClosedConnection: boolean;
    } | null = null;
    let terminalRevocation: Promise<boolean> | null = null;
    let preIssuedConnection: { url: string; accessToken: string } | null = null;
    if (operationMode === "read") {
      const status = await providerActionWithRetry(
        { url: connection.url, accessToken: connection.accessToken },
        "status",
      );
      const environmentStatus = asRecord(status.body);
      if (
        environmentStatus?.environmentId !== environmentId ||
        !Array.isArray(environmentStatus.processes)
      ) {
        throw new Error("SANDBOX_STATUS_INVALID");
      }
      processCount = environmentStatus.processes.length;
      providerReadiness = {
        clientAttempts: status.clientAttempts,
        providerAttempts: status.providerAttempts,
        durationMs: status.durationMs,
      };
    } else {
      const prepared = await providerActionWithRetry(
        { url: connection.url, accessToken: connection.accessToken },
        "prepare",
      );
      const prepareBody = asRecord(prepared.body);
      if (prepareBody?.status !== "ready" || prepareBody.environmentId !== environmentId) {
        throw new Error("SANDBOX_PREPARE_INVALID");
      }
      providerReadiness = {
        clientAttempts: prepared.clientAttempts,
        providerAttempts: prepared.providerAttempts,
        durationMs: prepared.durationMs,
      };
      terminalSocket = await openVerifiedTerminal(connection.url, connection.accessToken);
      const replayRejected = await verifyTicketRejected(
        connection.url,
        connection.accessToken,
        "SANDBOX_TERMINAL_TICKET_REPLAY_ACCEPTED",
      );
      const preIssuedRequestId = crypto.randomUUID();
      const preIssuedExecution = asRecord(
        await executeAgentCapability({
          config: registration.config,
          capability: "environment.connect",
          arguments: {
            organizationId,
            projectId,
            environmentId,
            operationMode,
            requestId: preIssuedRequestId,
            validUntil,
          },
        }),
      );
      const preIssued = asRecord(preIssuedExecution?.data) ?? preIssuedExecution;
      if (
        preIssued?.requestId !== preIssuedRequestId ||
        preIssued.operationMode !== "execute" ||
        preIssued.transport !== "websocket" ||
        typeof preIssued.url !== "string" ||
        typeof preIssued.accessToken !== "string"
      ) {
        throw new Error("PREISSUED_ENVIRONMENT_CONNECTION_INVALID");
      }
      preIssuedConnection = { url: preIssued.url, accessToken: preIssued.accessToken };
      terminalRevocation = waitForTerminalRevocation(terminalSocket);
      terminalVerified = {
        markerObserved: true,
        replayRejected,
        preIssuedTicketRejected: false,
        revocationClosedConnection: false,
      };
    }

    if (revocationMode === "grant") {
      const revoke = await userRequest(
        baseURL,
        "/api/auth/paca-agent/revoke-capability",
        approvalCookie,
        "POST",
        { agent_id: agentId, capabilities: ["environment.connect"] },
      );
      requireStatus(revoke.response, 200, revoke.body, "REVOKE_CAPABILITY");
      grantActive = false;
    } else if (revocationMode === "project-permission") {
      if (!projectRoleId || !projectRoleName) throw new Error("PROJECT_ROLE_REQUIRED");
      const updateRole = await userRequest(
        baseURL,
        `/api/v1/projects/${projectId}/roles/${projectRoleId}`,
        adminCookie,
        "PATCH",
        {
          role_name: projectRoleName,
          permissions: {
            "agents.approveGrant": true,
            "environments.read": true,
          },
        },
      );
      requireStatus(updateRole.response, 200, updateRole.body, "REVOKE_PROJECT_PERMISSION");
    } else {
      const archive = await userRequest(
        baseURL,
        `/api/v1/projects/${projectId}/environments/${environmentId}`,
        adminCookie,
        "DELETE",
      );
      requireStatus(archive.response, 204, archive.body, "ARCHIVE_ENVIRONMENT");
    }
    if (preIssuedConnection && terminalVerified) {
      terminalVerified.preIssuedTicketRejected = await verifyTicketRejected(
        preIssuedConnection.url,
        preIssuedConnection.accessToken,
        "REVOKED_PREISSUED_ENVIRONMENT_TICKET_ACCEPTED",
      );
    }
    let newConnectionRejected = false;
    try {
      await executeAgentCapability({
        config: registration.config,
        capability: "environment.connect",
        arguments: {
          organizationId,
          projectId,
          environmentId,
          operationMode,
          requestId: crypto.randomUUID(),
          validUntil,
        },
      });
    } catch {
      newConnectionRejected = true;
    }
    if (!newConnectionRejected) throw new Error("REVOKED_ENVIRONMENT_GRANT_ACCEPTED");
    if (terminalRevocation && terminalVerified) {
      terminalVerified.revocationClosedConnection = await terminalRevocation;
    }

    console.log(
      JSON.stringify({
        status: "ok",
        step: "environment-smoke",
        projectId,
        environmentId,
        agentId,
        harness: "local",
        backend: "cloudflare-sandbox",
        operationMode,
        revocationMode,
        coldStartReference: gatewayReference,
        providerClientAttempts: providerReadiness?.clientAttempts,
        providerAttempts: providerReadiness?.providerAttempts,
        providerReadyDurationMs: providerReadiness?.durationMs,
        ...(processCount === null ? {} : { processCount }),
        ...(terminalVerified ?? {}),
        grantRevoked: revocationMode === "grant",
        projectPermissionRevoked: revocationMode === "project-permission",
        environmentArchived: revocationMode === "environment-archive",
        newConnectionRejected,
      }),
    );
  } finally {
    if (terminalSocket && terminalSocket.readyState !== WebSocket.CLOSED) {
      terminalSocket.close(1000, "environment smoke cleanup");
    }
    if (agentId && grantActive && approvalCookie) {
      const cleanupGrant = await userRequest(
        baseURL,
        "/api/auth/paca-agent/revoke-capability",
        approvalCookie,
        "POST",
        {
          agent_id: agentId,
          capabilities: ["environment.connect"],
        },
      ).catch(() => null);
      if (cleanupGrant?.response.ok) grantActive = false;
    }
    if (agentId && approvalCookie) {
      await userRequest(baseURL, "/api/auth/agent/revoke", approvalCookie, "POST", {
        agent_id: agentId,
      }).catch(() => null);
    }
    if (delegatedCookie) {
      await userRequest(baseURL, "/api/auth/sign-out", delegatedCookie, "POST", {}).catch(
        () => null,
      );
    }
    if (projectMemberId && adminCookie) {
      await userRequest(
        baseURL,
        `/api/v1/projects/${projectId}/members/${projectMemberId}`,
        adminCookie,
        "DELETE",
      ).catch(() => null);
    }
    if (projectRoleId && adminCookie) {
      await userRequest(
        baseURL,
        `/api/v1/projects/${projectId}/roles/${projectRoleId}`,
        adminCookie,
        "DELETE",
      ).catch(() => null);
    }
    if (delegatedUserId) {
      await query(
        role.databaseURL,
        `DELETE FROM public."user" WHERE id = ${sqlLiteral(delegatedUserId)}`,
      ).catch(() => undefined);
    }
    if (adminCookie) {
      await userRequest(baseURL, "/api/auth/sign-out", adminCookie, "POST", {}).catch(() => null);
    }
    if (scopeCreated) {
      await query(
        role.databaseURL,
        `DELETE FROM public.paca_environment_scope
         WHERE environment_id = ${sqlLiteral(environmentId)}::uuid`,
      ).catch(() => undefined);
    }
    await deleteTemporaryDatabaseRole(pscaleOrganization, role.id).catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  const code = error instanceof Error ? redact(error.message) : "UNKNOWN_ERROR";
  console.error(JSON.stringify({ status: "error", step: "environment-smoke", code }));
  process.exitCode = 1;
});
