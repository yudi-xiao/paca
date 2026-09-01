import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  encodeStateAsUpdate,
  Doc as YDoc,
  XmlElement as YXmlElement,
  XmlText as YXmlText,
} from "yjs";

import {
  type DelegatedAgentConfig,
  fetchWithDelegatedAgent,
  getDelegatedAgentStatus,
} from "../src/agent-auth/agent-client";
import { DOCUMENT_AGENT_WORKFLOW_ID } from "../src/agent-run/document-workflow-protocol";

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
) {
  const headers = new Headers({ origin: baseURL });
  headers.set("cookie", cookie);
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

async function agentRequest(
  config: DelegatedAgentConfig,
  path: string,
  method: string,
  body?: JsonRecord,
) {
  const response = await fetchWithDelegatedAgent({
    config,
    path,
    capabilities: ["workflow.execute", "document.edit"],
    init: {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    },
  });
  return { response, body: await jsonOrNull(response) };
}

function data(value: unknown, step: string): JsonRecord {
  const result = asRecord(asRecord(value)?.data);
  if (!result) throw new Error(`${step}_DATA_INVALID`);
  return result;
}

function requireStatus(response: Response, expected: number, body: unknown, step: string) {
  if (response.status !== expected) {
    throw new Error(responseCode(body, `${step}_HTTP_${response.status}`));
  }
}

function initialDocumentUpdate(): string {
  const document = new YDoc();
  const group = new YXmlElement("blockGroup");
  const container = new YXmlElement("blockContainer");
  container.setAttribute("id", "workflow-smoke-block");
  const paragraph = new YXmlElement("paragraph");
  const text = new YXmlText();
  text.insert(0, "Agent Workflow smoke baseline");
  paragraph.insert(0, [text]);
  container.insert(0, [paragraph]);
  group.insert(0, [container]);
  document.getXmlFragment("document-store").insert(0, [group]);
  const update = Buffer.from(encodeStateAsUpdate(document)).toString("base64");
  document.destroy();
  return update;
}

async function delay(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function archiveStaleSmokeDocuments(baseURL: string, projectId: string, cookie: string) {
  const listed = await userRequest(baseURL, `/api/v1/projects/${projectId}/docs`, cookie, "GET");
  requireStatus(listed.response, 200, listed.body, "LIST_DOCUMENTS");
  const items = asRecord(data(listed.body, "LIST_DOCUMENTS"))?.items;
  if (!Array.isArray(items)) throw new Error("LIST_DOCUMENTS_ITEMS_INVALID");
  for (const value of items) {
    const document = asRecord(value);
    if (
      typeof document?.id !== "string" ||
      typeof document.title !== "string" ||
      !document.title.startsWith("Agent Workflow smoke ")
    ) {
      continue;
    }
    const archived = await userRequest(
      baseURL,
      `/api/v1/projects/${projectId}/docs/${document.id}`,
      cookie,
      "DELETE",
    );
    if (archived.response.status !== 204) {
      throw new Error(
        responseCode(archived.body, `ARCHIVE_STALE_HTTP_${archived.response.status}`),
      );
    }
  }
}

async function main() {
  const baseURL = new URL(
    process.env.PACA_INTERNAL_BASE_URL?.trim() || "https://paca.howlearnwood.com",
  ).origin;
  const organizationId = process.env.PACA_ORGANIZATION_ID?.trim() || "paca-default";
  const projectId = required("PACA_PROJECT_ID");
  const configPath =
    process.env.PACA_AGENT_CONFIG?.trim() ||
    fileURLToPath(new URL(".paca/agents/demo-task-agent-5.json", root));
  const config = JSON.parse(await readFile(configPath, "utf8")) as DelegatedAgentConfig;
  const signIn = await userRequest(baseURL, "/api/auth/sign-in/email", "", "POST", {
    email: required("PACA_APPROVER_EMAIL"),
    password: required("PACA_APPROVER_PASSWORD"),
    rememberMe: false,
  });
  requireStatus(signIn.response, 200, signIn.body, "SIGN_IN");
  const cookie = sessionCookie(signIn.response);
  let documentId: string | null = null;
  let grantsActive = false;
  const validUntil = new Date(Date.now() + 10 * 60_000).toISOString();

  try {
    await archiveStaleSmokeDocuments(baseURL, projectId, cookie);
    // Agent Auth can transparently reactivate an idle Agent and intentionally
    // clear its old grants. Reactivate first, then issue this smoke's exact
    // short-lived grants so the first Workflow request cannot discard them.
    await getDelegatedAgentStatus({ config });
    const created = await userRequest(
      baseURL,
      `/api/v1/projects/${projectId}/docs`,
      cookie,
      "POST",
      { title: `Agent Workflow smoke ${crypto.randomUUID().slice(0, 8)}`, content: null },
    );
    requireStatus(created.response, 201, created.body, "CREATE_DOCUMENT");
    const createdData = data(created.body, "CREATE_DOCUMENT");
    if (typeof createdData.id !== "string") throw new Error("CREATE_DOCUMENT_ID_INVALID");
    documentId = createdData.id;
    const bootstrap = await userRequest(
      baseURL,
      `/api/v1/projects/${projectId}/docs/${documentId}/collaboration/bootstrap`,
      cookie,
      "POST",
      { update_base64: initialDocumentUpdate() },
    );
    requireStatus(bootstrap.response, 200, bootstrap.body, "BOOTSTRAP_DOCUMENT");
    if (data(bootstrap.body, "BOOTSTRAP_DOCUMENT").initialized !== true) {
      throw new Error("BOOTSTRAP_DOCUMENT_NOT_INITIALIZED");
    }

    const granted = await userRequest(baseURL, "/api/auth/agent/grant-capability", cookie, "POST", {
      agent_id: config.agentId,
      capabilities: [
        {
          name: "workflow.execute",
          constraints: {
            organizationId,
            projectId,
            workflowId: DOCUMENT_AGENT_WORKFLOW_ID,
            operationMode: "execute",
            validUntil,
          },
        },
        {
          name: "document.edit",
          constraints: {
            organizationId,
            projectId,
            documentId,
            field: "block.content",
            operationMode: "exclusive",
            action: "acquire_lease",
            validUntil,
          },
        },
      ],
      ttl: 600,
    });
    requireStatus(granted.response, 200, granted.body, "GRANT_CAPABILITIES");
    grantsActive = true;

    const runId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const path = `/api/v1/agent/projects/${projectId}/workflows/${DOCUMENT_AGENT_WORKFLOW_ID}/runs`;
    const command = {
      organizationId,
      documentId,
      command: {
        action: "acquire_lease",
        requestId,
        runId,
        operationMode: "exclusive",
        leaseDurationMs: 5_000,
      },
    };
    const started = await agentRequest(config, path, "POST", command);
    requireStatus(started.response, 200, started.body, "START_WORKFLOW");
    if (data(started.body, "START_WORKFLOW").id !== runId) {
      throw new Error("START_WORKFLOW_RUN_ID_INVALID");
    }

    let final: JsonRecord | null = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const status = await agentRequest(config, `${path}/${runId}`, "GET");
      requireStatus(status.response, 200, status.body, "READ_WORKFLOW");
      final = data(status.body, "READ_WORKFLOW");
      if (["succeeded", "failed", "cancelled"].includes(String(final.status))) break;
      await delay(1_000);
    }
    if (final?.status !== "succeeded") {
      throw new Error(`WORKFLOW_${String(final?.status ?? "TIMEOUT").toUpperCase()}`);
    }

    const duplicate = await agentRequest(config, path, "POST", command);
    requireStatus(duplicate.response, 200, duplicate.body, "DUPLICATE_WORKFLOW");
    if (data(duplicate.body, "DUPLICATE_WORKFLOW").id !== runId) {
      throw new Error("DUPLICATE_WORKFLOW_RUN_ID_INVALID");
    }

    const changed = await agentRequest(config, path, "POST", {
      ...command,
      command: { ...command.command, leaseDurationMs: 6_000 },
    });
    if (
      changed.response.status !== 409 ||
      asRecord(changed.body)?.error_code !== "AGENT_RUN_IDEMPOTENCY_CONFLICT"
    ) {
      throw new Error("CHANGED_RETRY_NOT_REJECTED");
    }

    console.log(
      JSON.stringify({
        status: "ok",
        step: "agent-workflow-smoke",
        agentId: config.agentId,
        projectId,
        documentId,
        runId,
        runStatus: final.status,
        runVersion: final.version,
        duplicateAccepted: true,
        changedRetryRejected: true,
      }),
    );
  } finally {
    if (grantsActive) {
      await userRequest(baseURL, "/api/auth/paca-agent/revoke-capability", cookie, "POST", {
        agent_id: config.agentId,
        capabilities: ["workflow.execute", "document.edit"],
      }).catch(() => null);
    }
    if (documentId) {
      await delay(5_500);
      await userRequest(
        baseURL,
        `/api/v1/projects/${projectId}/docs/${documentId}`,
        cookie,
        "DELETE",
      ).catch(() => null);
    }
    await userRequest(baseURL, "/api/auth/sign-out", cookie, "POST", {}).catch(() => null);
  }
}

main().catch((error: unknown) => {
  const code = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  console.error(JSON.stringify({ status: "error", step: "agent-workflow-smoke", code }));
  process.exitCode = 1;
});
