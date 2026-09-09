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

async function verifyTerminalConnection(
  url: string,
  accessToken: string,
): Promise<{ markerObserved: boolean; replayRejected: boolean }> {
  const marker = `PACA_TERMINAL_SMOKE_${crypto.randomUUID().replaceAll("-", "")}`;
  await new Promise<void>((resolve, reject) => {
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
    }, 45_000);
    const succeed = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close(1000, "smoke complete");
      resolve();
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
  if (!replayRejected) throw new Error("SANDBOX_TERMINAL_TICKET_REPLAY_ACCEPTED");
  return { markerObserved: true, replayRejected };
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
  const pscaleOrganization = required("PACA_PLANETSCALE_ORG");
  const hostConfigPath =
    process.env.PACA_AGENT_HOST_CONFIG?.trim() ||
    fileURLToPath(new URL(".paca/agent-host.json", root));
  const environmentId = crypto.randomUUID();
  const gatewayReference = "paca-environment-smoke";
  const role = await createTemporaryDatabaseRole(pscaleOrganization);
  let scopeCreated = false;
  let agentId: string | null = null;
  let grantActive = false;
  let cookie = "";

  try {
    await query(
      role.databaseURL,
      `INSERT INTO public.paca_environment_scope
         (environment_id, project_id, backend, gateway_reference)
       VALUES (${sqlLiteral(environmentId)}::uuid, ${sqlLiteral(projectId)}::uuid,
               'cloudflare-sandbox', ${sqlLiteral(gatewayReference)})`,
    );
    scopeCreated = true;

    const signIn = await userRequest(baseURL, "/api/auth/sign-in/email", "", "POST", {
      email: required("PACA_APPROVER_EMAIL"),
      password: required("PACA_APPROVER_PASSWORD"),
      rememberMe: false,
    });
    requireStatus(signIn.response, 200, signIn.body, "SIGN_IN");
    cookie = sessionCookie(signIn.response);

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
    let terminalVerified: { markerObserved: boolean; replayRejected: boolean } | null = null;
    if (operationMode === "read") {
      const statusResponse = await fetch(connection.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${connection.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "status" }),
        redirect: "error",
        signal: AbortSignal.timeout(55_000),
      });
      const statusBody = await jsonOrNull(statusResponse);
      requireStatus(statusResponse, 200, statusBody, "SANDBOX_STATUS");
      const environmentStatus = asRecord(statusBody);
      if (
        environmentStatus?.environmentId !== environmentId ||
        !Array.isArray(environmentStatus.processes)
      ) {
        throw new Error("SANDBOX_STATUS_INVALID");
      }
      processCount = environmentStatus.processes.length;
    } else {
      terminalVerified = await verifyTerminalConnection(connection.url, connection.accessToken);
    }

    const revoke = await userRequest(
      baseURL,
      "/api/auth/paca-agent/revoke-capability",
      cookie,
      "POST",
      { agent_id: agentId, capabilities: ["environment.connect"] },
    );
    requireStatus(revoke.response, 200, revoke.body, "REVOKE_CAPABILITY");
    grantActive = false;

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
        ...(processCount === null ? {} : { processCount }),
        ...(terminalVerified ?? {}),
        grantRevoked: true,
      }),
    );
  } finally {
    if (agentId && grantActive && cookie) {
      await userRequest(baseURL, "/api/auth/paca-agent/revoke-capability", cookie, "POST", {
        agent_id: agentId,
        capabilities: ["environment.connect"],
      }).catch(() => null);
    }
    if (agentId && cookie) {
      await userRequest(baseURL, "/api/auth/agent/revoke", cookie, "POST", {
        agent_id: agentId,
      }).catch(() => null);
    }
    if (cookie) {
      await userRequest(baseURL, "/api/auth/sign-out", cookie, "POST", {}).catch(() => null);
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
