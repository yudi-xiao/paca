import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { type DelegatedAgentConfig, executeAgentCapability } from "../src/agent-auth/agent-client";

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
  const value = record?.code ?? record?.error ?? record?.message;
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

async function post(
  baseURL: string,
  path: string,
  body: JsonRecord,
  cookie?: string,
): Promise<{ response: Response; body: unknown }> {
  const headers = new Headers({ "content-type": "application/json", origin: baseURL });
  if (cookie) headers.set("cookie", cookie);
  const response = await fetch(`${baseURL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    redirect: "manual",
  });
  return { response, body: await jsonOrNull(response) };
}

async function main(): Promise<void> {
  const baseURL = new URL(
    process.env.PACA_INTERNAL_BASE_URL?.trim() || "https://paca.howlearnwood.com",
  ).origin;
  const email = required("PACA_APPROVER_EMAIL");
  const password = required("PACA_APPROVER_PASSWORD");
  const organizationId = process.env.PACA_ORGANIZATION_ID?.trim() || "paca-default";
  const projectId = required("PACA_PROJECT_ID");
  const configPath =
    process.env.PACA_AGENT_CONFIG?.trim() ||
    fileURLToPath(new URL(".paca/agents/demo-task-agent-5.json", root));
  const config = JSON.parse(await readFile(configPath, "utf8")) as DelegatedAgentConfig;
  const validUntil = new Date(Date.now() + 10 * 60_000).toISOString();

  const signIn = await post(baseURL, "/api/auth/sign-in/email", {
    email,
    password,
    rememberMe: false,
  });
  if (!signIn.response.ok) {
    throw new Error(responseCode(signIn.body, `SIGN_IN_HTTP_${signIn.response.status}`));
  }
  const cookie = sessionCookie(signIn.response);
  let granted = false;
  let grantIds: string[] = [];

  try {
    const grant = await post(
      baseURL,
      "/api/auth/agent/grant-capability",
      {
        agent_id: config.agentId,
        capabilities: [
          {
            name: "project.read",
            constraints: { organizationId, projectId, validUntil },
          },
        ],
        ttl: 600,
      },
      cookie,
    );
    if (!grant.response.ok) {
      throw new Error(responseCode(grant.body, `GRANT_HTTP_${grant.response.status}`));
    }
    const grantBody = asRecord(grant.body);
    grantIds = Array.isArray(grantBody?.grant_ids)
      ? grantBody.grant_ids.filter((value): value is string => typeof value === "string")
      : [];
    if (!Array.isArray(grantBody?.added) || !grantBody.added.includes("project.read")) {
      throw new Error("GRANT_RESPONSE_INVALID");
    }
    granted = true;

    const execution = await executeAgentCapability({
      config,
      capability: "project.read",
      arguments: { organizationId, projectId, validUntil },
    });
    if (!asRecord(execution)) throw new Error("EXECUTION_RESPONSE_INVALID");

    const revoke = await post(
      baseURL,
      "/api/auth/paca-agent/revoke-capability",
      { agent_id: config.agentId, capabilities: ["project.read"] },
      cookie,
    );
    if (!revoke.response.ok) {
      throw new Error(responseCode(revoke.body, `REVOKE_HTTP_${revoke.response.status}`));
    }
    const revokeBody = asRecord(revoke.body);
    if (!Array.isArray(revokeBody?.revoked) || !revokeBody.revoked.includes("project.read")) {
      throw new Error("REVOKE_RESPONSE_INVALID");
    }
    granted = false;

    console.log(
      JSON.stringify({
        status: "ok",
        agentId: config.agentId,
        projectId,
        capability: "project.read",
        grantIds,
        grantStatus: "revoked",
        auditEventsExpected: ["capability.granted", "capability.executed", "capability.revoked"],
      }),
    );
  } finally {
    if (granted) {
      await post(
        baseURL,
        "/api/auth/paca-agent/revoke-capability",
        { agent_id: config.agentId, capabilities: ["project.read"] },
        cookie,
      ).catch(() => null);
    }
    await post(baseURL, "/api/auth/sign-out", {}, cookie).catch(() => null);
  }
}

main().catch((error: unknown) => {
  const code = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  console.error(JSON.stringify({ status: "error", step: "agent-audit-smoke", code }));
  process.exitCode = 1;
});
