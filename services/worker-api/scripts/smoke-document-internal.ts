import { fileURLToPath } from "node:url";

import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import {
  applyUpdate,
  encodeStateAsUpdate,
  encodeStateVector,
  Doc as YDoc,
  XmlElement as YXmlElement,
  XmlText as YXmlText,
} from "yjs";

import {
  type DelegatedAgentConfig,
  executeAgentCapability,
  readAgentHostConfig,
  registerDelegatedAgentWithCapabilities,
} from "../src/agent-auth/agent-client";
import { AgentHostEnrollmentError } from "../src/agent-auth/host-enrollment";

type JsonRecord = Record<string, unknown>;
type BunWebSocketConstructor = new (
  url: string,
  options: { headers: Record<string, string> },
) => WebSocket;

const MESSAGE_SYNC = 0;
const DEFAULT_TIMEOUT_MS = 60_000;
const root = new URL("../../../", import.meta.url);

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_NOT_CONFIGURED`);
  return value;
}

function optionalDuration(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 300_000) {
    throw new Error(`${name}_INVALID`);
  }
  return parsed;
}

function internalBaseURL(): string {
  const configured = new URL(
    process.env.PACA_INTERNAL_BASE_URL?.trim() || "https://paca.howlearnwood.com",
  );
  if (
    configured.protocol !== "https:" ||
    configured.username ||
    configured.password ||
    configured.pathname !== "/" ||
    configured.search ||
    configured.hash
  ) {
    throw new Error("PACA_INTERNAL_BASE_URL_INVALID");
  }
  return configured.origin;
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function requireData(value: unknown, step: string): JsonRecord {
  const data = asRecord(asRecord(value)?.data);
  if (!data) throw new Error(`${step}_DATA_INVALID`);
  return data;
}

function requireId(value: JsonRecord, step: string): string {
  if (typeof value.id !== "string") throw new Error(`${step}_ID_INVALID`);
  return value.id;
}

function requireStatus(response: Response, expected: number, step: string): void {
  if (response.status !== expected) throw new Error(`${step}_HTTP_${response.status}`);
}

function responseCode(body: unknown, fallback: string): string {
  const record = asRecord(body);
  const value = record?.code ?? record?.error ?? record?.message;
  return typeof value === "string" ? value : fallback;
}

async function jsonOrNull(response: Response): Promise<unknown> {
  return (response.headers.get("content-type") ?? "").includes("application/json")
    ? response.json().catch(() => null)
    : null;
}

function sessionCookie(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? [headers.get("set-cookie") ?? ""];
  for (const value of values) {
    const match = value.match(/(?:^|,\s*)([^=;,\s]*session_token)=([^;,\s]+)/i);
    if (match?.[1] && match[2]) return `${match[1]}=${match[2]}`;
  }
  throw new Error("SESSION_COOKIE_MISSING");
}

function log(step: string, details: JsonRecord = {}): void {
  console.log(JSON.stringify({ status: "ok", step, ...details }));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function request(
  baseURL: string,
  path: string,
  cookie: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  headers.set("origin", baseURL);
  return fetch(`${baseURL}${path}`, { ...init, headers, redirect: "manual" });
}

async function jsonRequest(
  baseURL: string,
  path: string,
  cookie: string,
  method: string,
  body: JsonRecord,
): Promise<{ response: Response; body: unknown }> {
  const response = await request(baseURL, path, cookie, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await jsonOrNull(response) };
}

function paragraph(id: string, value: string): YXmlElement {
  const container = new YXmlElement("blockContainer");
  container.setAttribute("id", id);
  const content = new YXmlElement("paragraph");
  const text = new YXmlText();
  text.insert(0, value);
  content.insert(0, [text]);
  container.insert(0, [content]);
  return container;
}

function initialDocument(): YDoc {
  const document = new YDoc();
  const group = new YXmlElement("blockGroup");
  group.insert(0, [paragraph("block-a", "Alpha"), paragraph("block-b", "Beta")]);
  document.getXmlFragment("document-store").insert(0, [group]);
  return document;
}

function replaceParagraphText(document: YDoc, blockId: string, value: string): void {
  const group = document.getXmlFragment("document-store").get(0);
  if (!(group instanceof YXmlElement)) throw new Error("BLOCK_GROUP_MISSING");
  const container = group
    .toArray()
    .find(
      (candidate): candidate is YXmlElement =>
        candidate instanceof YXmlElement && candidate.getAttribute("id") === blockId,
    );
  const content = container?.get(0);
  if (!(content instanceof YXmlElement)) throw new Error("BLOCK_CONTENT_MISSING");
  document.transact(() => {
    if (content.length > 0) content.delete(0, content.length);
    const text = new YXmlText();
    text.insert(0, value);
    content.insert(0, [text]);
  });
}

function userUpdate(baseline: Uint8Array, blockId: string, value: string): Uint8Array {
  const document = new YDoc();
  applyUpdate(document, baseline);
  const before = encodeStateVector(document);
  replaceParagraphText(document, blockId, value);
  const update = encodeStateAsUpdate(document, before);
  document.destroy();
  return update;
}

function framedUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

function snapshotBlock(snapshot: JsonRecord, blockId: string): JsonRecord {
  if (!Array.isArray(snapshot.blocks)) throw new Error("AGENT_SNAPSHOT_BLOCKS_INVALID");
  for (const value of snapshot.blocks) {
    const block = asRecord(value);
    if (block?.blockId === blockId) return block;
  }
  throw new Error("AGENT_SNAPSHOT_BLOCK_MISSING");
}

function snapshotBlockText(snapshot: JsonRecord, blockId: string): string {
  const block = snapshotBlock(snapshot, blockId);
  if (typeof block.blockJson !== "string") throw new Error("AGENT_BLOCK_JSON_INVALID");
  const materialized = asRecord(JSON.parse(block.blockJson) as unknown);
  if (!Array.isArray(materialized?.content)) throw new Error("AGENT_BLOCK_CONTENT_INVALID");
  return materialized.content
    .map(asRecord)
    .filter((value): value is JsonRecord => Boolean(value))
    .map((value) => (typeof value.text === "string" ? value.text : ""))
    .join("");
}

function snapshotRevision(snapshot: JsonRecord): number {
  if (!Number.isSafeInteger(snapshot.revision)) throw new Error("AGENT_SNAPSHOT_REVISION_INVALID");
  return snapshot.revision as number;
}

function editOperation(snapshot: JsonRecord, blockId: string, text: string): JsonRecord {
  const block = snapshotBlock(snapshot, blockId);
  if (typeof block.version !== "string") throw new Error("AGENT_BLOCK_VERSION_INVALID");
  return {
    type: "replace_block_content",
    blockId,
    expectedBlockVersion: block.version,
    content: [{ type: "text", text, styles: {} }],
  };
}

async function executeDocument(
  config: DelegatedAgentConfig,
  capability: "document.edit" | "document.read",
  arguments_: JsonRecord,
  step: string,
): Promise<JsonRecord> {
  return requireData(
    await executeAgentCapability({ config, capability, arguments: arguments_ }),
    step,
  );
}

function waitForLeaseStatus(
  socket: WebSocket,
  active: boolean,
  timeoutMs: number,
): Promise<JsonRecord> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(
        new Error(active ? "DOCUMENT_LEASE_ACTIVE_TIMEOUT" : "DOCUMENT_LEASE_INACTIVE_TIMEOUT"),
      );
    }, timeoutMs);
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string" || !event.data.startsWith("__YPS:")) return;
      let message: JsonRecord | null = null;
      try {
        message = asRecord(JSON.parse(event.data.slice(6)) as unknown);
      } catch {
        return;
      }
      if (message?.type !== "document.agent-lease" || message.active !== active) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      resolve(message);
    };
    socket.addEventListener("message", onMessage);
  });
}

async function connectDocumentParty(
  baseURL: string,
  cookie: string,
  documentId: string,
  timeoutMs: number,
): Promise<WebSocket> {
  const url = new URL(baseURL);
  url.protocol = "wss:";
  url.pathname = `/ws/parties/document-party/${encodeURIComponent(documentId)}`;
  const ClientWebSocket = WebSocket as unknown as BunWebSocketConstructor;
  const socket = new ClientWebSocket(url.toString(), {
    headers: { cookie, origin: baseURL },
  });
  const opened = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("DOCUMENT_WEBSOCKET_OPEN_TIMEOUT")),
      timeoutMs,
    );
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        reject(new Error("DOCUMENT_WEBSOCKET_OPEN_FAILED"));
      },
      { once: true },
    );
  });
  const initialLease = waitForLeaseStatus(socket, false, timeoutMs);
  await opened;
  await initialLease;
  return socket;
}

async function closeSocket(socket: WebSocket | null): Promise<void> {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 5_000);
    socket.addEventListener(
      "close",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
  socket.close(1000, "document smoke disconnect");
  await closed;
}

async function cleanupStep(
  failures: string[],
  step: string,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch {
    failures.push(step);
    console.error(
      JSON.stringify({ status: "warning", step: "document-smoke-cleanup", code: `${step}_FAILED` }),
    );
  }
}

async function poll<T>(
  operation: () => Promise<T>,
  accepted: (value: T) => boolean,
  timeoutMs: number,
  timeoutCode: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null = null;
  while (Date.now() < deadline) {
    last = await operation();
    if (accepted(last)) return last;
    await delay(500);
  }
  if (last !== null && accepted(last)) return last;
  throw new Error(timeoutCode);
}

async function main(): Promise<void> {
  const baseURL = internalBaseURL();
  const email = requiredEnvironment("PACA_DOCUMENT_SMOKE_EMAIL");
  const password = requiredEnvironment("PACA_DOCUMENT_SMOKE_PASSWORD");
  const timeoutMs = optionalDuration("PACA_DOCUMENT_SMOKE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const runId = process.env.PACA_DOCUMENT_SMOKE_RUN_ID?.trim() || crypto.randomUUID();
  const organizationId = process.env.PACA_ORGANIZATION_ID?.trim() || "paca-default";
  const hostConfigPath =
    process.env.PACA_AGENT_HOST_CONFIG?.trim() ||
    fileURLToPath(new URL(".paca/agent-host.json", root));
  if (!email.includes("@")) throw new Error("PACA_DOCUMENT_SMOKE_EMAIL_INVALID");
  if (password.length < 12) throw new Error("PACA_DOCUMENT_SMOKE_PASSWORD_TOO_SHORT");
  if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error("PACA_DOCUMENT_SMOKE_RUN_ID_INVALID");

  const signIn = await fetch(`${baseURL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseURL },
    body: JSON.stringify({ email, password, rememberMe: false }),
    redirect: "manual",
  });
  const signInBody = await jsonOrNull(signIn);
  if (!signIn.ok) {
    throw new Error(responseCode(signInBody, `SIGN_IN_HTTP_${signIn.status}`));
  }
  const cookie = sessionCookie(signIn);
  let projectId: string | null = null;
  let documentId: string | null = null;
  let agentId: string | null = null;
  let documentEditGrantActive = false;
  let socket: WebSocket | null = null;

  try {
    const createProject = await jsonRequest(baseURL, "/api/v1/projects", cookie, "POST", {
      name: `Document smoke ${runId.slice(0, 8)}`,
      task_id_prefix: `DOC${runId.replaceAll("-", "").slice(0, 5).toUpperCase()}`,
    });
    requireStatus(createProject.response, 201, "CREATE_PROJECT");
    projectId = requireId(requireData(createProject.body, "CREATE_PROJECT"), "PROJECT");

    const createDocument = await jsonRequest(
      baseURL,
      `/api/v1/projects/${projectId}/docs`,
      cookie,
      "POST",
      { title: `Document Agent smoke ${runId.slice(0, 8)}`, content: null },
    );
    requireStatus(createDocument.response, 201, "CREATE_DOCUMENT");
    documentId = requireId(requireData(createDocument.body, "CREATE_DOCUMENT"), "DOCUMENT");

    const baselineDocument = initialDocument();
    const baseline = encodeStateAsUpdate(baselineDocument);
    baselineDocument.destroy();
    const bootstrap = await jsonRequest(
      baseURL,
      `/api/v1/projects/${projectId}/docs/${documentId}/collaboration/bootstrap`,
      cookie,
      "POST",
      { update_base64: Buffer.from(baseline).toString("base64") },
    );
    requireStatus(bootstrap.response, 200, "BOOTSTRAP_DOCUMENT");
    if (requireData(bootstrap.body, "BOOTSTRAP_DOCUMENT").initialized !== true) {
      throw new Error("BOOTSTRAP_DOCUMENT_NOT_INITIALIZED");
    }
    log("document-smoke-fixture-created", { runId, projectId, documentId });

    const hostConfig = await readAgentHostConfig(hostConfigPath);
    if (
      new URL(hostConfig.providerOrigin).origin !== baseURL ||
      new URL(hostConfig.issuer).origin !== baseURL ||
      new URL(hostConfig.defaultLocation).origin !== baseURL
    ) {
      throw new Error("PACA_AGENT_HOST_ORIGIN_MISMATCH");
    }
    const validUntil = new Date(Date.now() + 10 * 60_000).toISOString();
    const registration = await registerDelegatedAgentWithCapabilities({
      hostConfig,
      agentName: `Document smoke Agent ${runId.slice(0, 8)}`,
      capabilityRequests: [
        {
          capability: "document.read",
          constraints: { organizationId, projectId, documentId, validUntil },
        },
        {
          capability: "document.edit",
          constraints: {
            organizationId,
            projectId,
            documentId,
            field: "block.content",
            operationMode: { in: ["suggest", "collaborate", "exclusive"] },
            action: { in: ["apply", "acquire_lease", "renew_lease", "release_lease"] },
            validUntil,
          },
        },
      ],
      reason: "验证 Paca 文档建议、协作和独占编辑纵向链路。",
      bindingMessage: "仅限临时 Document smoke 项目和文档，十分钟后失效。",
    });
    agentId = registration.config.agentId;
    const approval = await jsonRequest(
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
    requireStatus(approval.response, 200, "APPROVE_AGENT");
    if (asRecord(approval.body)?.status !== "approved") {
      throw new Error("APPROVE_AGENT_RESPONSE_INVALID");
    }
    documentEditGrantActive = true;
    const agent = registration.config;
    const scope = { organizationId, projectId, documentId, validUntil };
    log("document-smoke-agent-approved", { agentId, projectId, documentId });

    let snapshot = await executeDocument(agent, "document.read", scope, "AGENT_DOCUMENT_READ");
    if (snapshotBlockText(snapshot, "block-a") !== "Alpha") {
      throw new Error("AGENT_DOCUMENT_INITIAL_CONTENT_INVALID");
    }

    const suggestion = await executeDocument(
      agent,
      "document.edit",
      {
        ...scope,
        field: "block.content",
        action: "apply",
        requestId: crypto.randomUUID(),
        runId,
        baseRevision: snapshotRevision(snapshot),
        baseStateVector: snapshot.stateVector,
        operationMode: "suggest",
        operations: [editOperation(snapshot, "block-a", "Suggested Agent update")],
      },
      "AGENT_DOCUMENT_SUGGEST",
    );
    if (suggestion.applied !== false || suggestion.mode !== "suggest") {
      throw new Error("AGENT_DOCUMENT_SUGGEST_RESULT_INVALID");
    }

    const collaboration = await executeDocument(
      agent,
      "document.edit",
      {
        ...scope,
        field: "block.content",
        action: "apply",
        requestId: crypto.randomUUID(),
        runId,
        baseRevision: snapshotRevision(snapshot),
        baseStateVector: snapshot.stateVector,
        operationMode: "collaborate",
        operations: [editOperation(snapshot, "block-a", "Collaborative Agent update")],
      },
      "AGENT_DOCUMENT_COLLABORATE",
    );
    if (collaboration.applied !== true || collaboration.mode !== "collaborate") {
      throw new Error("AGENT_DOCUMENT_COLLABORATE_RESULT_INVALID");
    }

    socket = await connectDocumentParty(baseURL, cookie, documentId, timeoutMs);
    await closeSocket(socket);
    socket = await connectDocumentParty(baseURL, cookie, documentId, timeoutMs);
    log("document-smoke-user-reconnected", { projectId, documentId });

    snapshot = await executeDocument(agent, "document.read", scope, "AGENT_DOCUMENT_REREAD");
    const activeLeaseMessage = waitForLeaseStatus(socket, true, timeoutMs);
    const lease = await executeDocument(
      agent,
      "document.edit",
      {
        ...scope,
        field: "block.content",
        action: "acquire_lease",
        requestId: crypto.randomUUID(),
        runId,
        operationMode: "exclusive",
        leaseDurationMs: 30_000,
      },
      "AGENT_DOCUMENT_ACQUIRE_LEASE",
    );
    if (lease.acquired !== true || typeof lease.leaseId !== "string") {
      throw new Error("AGENT_DOCUMENT_LEASE_RESULT_INVALID");
    }
    await activeLeaseMessage;

    socket.send(framedUpdate(userUpdate(baseline, "block-b", "Blocked user update")));
    await delay(750);
    snapshot = await executeDocument(agent, "document.read", scope, "AGENT_DOCUMENT_LEASE_READ");
    if (snapshotBlockText(snapshot, "block-b") !== "Beta") {
      throw new Error("DOCUMENT_LEASE_USER_WRITE_NOT_BLOCKED");
    }

    const exclusive = await executeDocument(
      agent,
      "document.edit",
      {
        ...scope,
        field: "block.content",
        action: "apply",
        requestId: crypto.randomUUID(),
        runId,
        baseRevision: snapshotRevision(snapshot),
        baseStateVector: snapshot.stateVector,
        operationMode: "exclusive",
        leaseId: lease.leaseId,
        operations: [editOperation(snapshot, "block-a", "Exclusive Agent update")],
      },
      "AGENT_DOCUMENT_EXCLUSIVE_APPLY",
    );
    if (exclusive.applied !== true || exclusive.mode !== "exclusive") {
      throw new Error("AGENT_DOCUMENT_EXCLUSIVE_RESULT_INVALID");
    }

    const renewedLeaseMessage = waitForLeaseStatus(socket, true, timeoutMs);
    const renewed = await executeDocument(
      agent,
      "document.edit",
      {
        ...scope,
        field: "block.content",
        action: "renew_lease",
        requestId: crypto.randomUUID(),
        runId,
        operationMode: "exclusive",
        leaseId: lease.leaseId,
        leaseDurationMs: 30_000,
      },
      "AGENT_DOCUMENT_RENEW_LEASE",
    );
    if (renewed.acquired !== true || renewed.leaseId !== lease.leaseId) {
      throw new Error("AGENT_DOCUMENT_RENEW_RESULT_INVALID");
    }
    await renewedLeaseMessage;

    const releasedLeaseMessage = waitForLeaseStatus(socket, false, timeoutMs);
    const released = await executeDocument(
      agent,
      "document.edit",
      {
        ...scope,
        field: "block.content",
        action: "release_lease",
        requestId: crypto.randomUUID(),
        runId,
        operationMode: "exclusive",
        leaseId: lease.leaseId,
      },
      "AGENT_DOCUMENT_RELEASE_LEASE",
    );
    if (released.released !== true || released.leaseId !== lease.leaseId) {
      throw new Error("AGENT_DOCUMENT_RELEASE_RESULT_INVALID");
    }
    await releasedLeaseMessage;

    const reacquiredLeaseMessage = waitForLeaseStatus(socket, true, timeoutMs);
    const reacquired = await executeDocument(
      agent,
      "document.edit",
      {
        ...scope,
        field: "block.content",
        action: "acquire_lease",
        requestId: crypto.randomUUID(),
        runId,
        operationMode: "exclusive",
        leaseDurationMs: 5_000,
      },
      "AGENT_DOCUMENT_REACQUIRE_LEASE",
    );
    if (reacquired.acquired !== true || typeof reacquired.leaseId !== "string") {
      throw new Error("AGENT_DOCUMENT_REACQUIRE_RESULT_INVALID");
    }
    await reacquiredLeaseMessage;

    await delay(5_500);
    const takeoverLeaseMessage = waitForLeaseStatus(socket, true, timeoutMs);
    const takeover = await executeDocument(
      agent,
      "document.edit",
      {
        ...scope,
        field: "block.content",
        action: "acquire_lease",
        requestId: crypto.randomUUID(),
        runId,
        operationMode: "exclusive",
        leaseDurationMs: 30_000,
      },
      "AGENT_DOCUMENT_EXPIRED_LEASE_TAKEOVER",
    );
    if (
      takeover.acquired !== true ||
      typeof takeover.leaseId !== "string" ||
      takeover.leaseId === reacquired.leaseId
    ) {
      throw new Error("AGENT_DOCUMENT_LEASE_TAKEOVER_RESULT_INVALID");
    }
    await takeoverLeaseMessage;

    const inactiveLeaseMessage = waitForLeaseStatus(socket, false, timeoutMs);
    const revokeEdit = await jsonRequest(
      baseURL,
      "/api/auth/paca-agent/revoke-capability",
      cookie,
      "POST",
      { agent_id: agentId, capabilities: ["document.edit"] },
    );
    requireStatus(revokeEdit.response, 200, "REVOKE_DOCUMENT_EDIT");
    if (!Array.isArray(asRecord(revokeEdit.body)?.revoked)) {
      throw new Error("REVOKE_DOCUMENT_EDIT_RESPONSE_INVALID");
    }
    documentEditGrantActive = false;
    await inactiveLeaseMessage;

    socket.send(framedUpdate(userUpdate(baseline, "block-b", "User update after revoke")));
    snapshot = await poll(
      () => executeDocument(agent, "document.read", scope, "AGENT_DOCUMENT_POST_REVOKE_READ"),
      (value) => snapshotBlockText(value, "block-b") === "User update after revoke",
      timeoutMs,
      "DOCUMENT_USER_WRITE_RECOVERY_TIMEOUT",
    );
    let revokedEditDenied = false;
    try {
      await executeDocument(
        agent,
        "document.edit",
        {
          ...scope,
          field: "block.content",
          action: "apply",
          requestId: crypto.randomUUID(),
          runId,
          baseRevision: snapshotRevision(snapshot),
          baseStateVector: snapshot.stateVector,
          operationMode: "collaborate",
          operations: [editOperation(snapshot, "block-a", "must be denied")],
        },
        "AGENT_DOCUMENT_REVOKED_EDIT",
      );
    } catch (error) {
      revokedEditDenied = error instanceof AgentHostEnrollmentError;
    }
    if (!revokedEditDenied) throw new Error("DOCUMENT_EDIT_AFTER_REVOKE_NOT_DENIED");

    const finalRevision = snapshotRevision(snapshot);
    await poll(
      async () => {
        const document = await request(
          baseURL,
          `/api/v1/projects/${projectId}/docs/${documentId}`,
          cookie,
        );
        requireStatus(document, 200, "GET_MATERIALIZED_DOCUMENT");
        return requireData(await document.json(), "GET_MATERIALIZED_DOCUMENT");
      },
      (value) =>
        typeof value.content_version === "number" && value.content_version >= finalRevision,
      timeoutMs,
      "DOCUMENT_MATERIALIZATION_TIMEOUT",
    );
    log("document-smoke-complete", {
      runId,
      projectId,
      documentId,
      agentId,
      finalRevision,
    });
  } finally {
    const cleanupFailures: string[] = [];
    await cleanupStep(cleanupFailures, "CLOSE_DOCUMENT_SOCKET", () => closeSocket(socket));
    if (agentId && documentEditGrantActive) {
      const cleanupAgentId = agentId;
      await cleanupStep(cleanupFailures, "REVOKE_DOCUMENT_EDIT", async () => {
        const revokeEdit = await jsonRequest(
          baseURL,
          "/api/auth/paca-agent/revoke-capability",
          cookie,
          "POST",
          { agent_id: cleanupAgentId, capabilities: ["document.edit"] },
        );
        requireStatus(revokeEdit.response, 200, "CLEANUP_REVOKE_DOCUMENT_EDIT");
        documentEditGrantActive = false;
        log("document-smoke-edit-grant-revoked", { agentId: cleanupAgentId });
      });
    }
    if (agentId) {
      const cleanupAgentId = agentId;
      await cleanupStep(cleanupFailures, "REVOKE_AGENT", async () => {
        const revokeAgent = await jsonRequest(baseURL, "/api/auth/agent/revoke", cookie, "POST", {
          agent_id: cleanupAgentId,
        });
        requireStatus(revokeAgent.response, 200, "REVOKE_AGENT");
        log("document-smoke-agent-revoked", { agentId: cleanupAgentId });
      });
    }
    if (projectId) {
      const cleanupProjectId = projectId;
      await cleanupStep(cleanupFailures, "ARCHIVE_PROJECT", async () => {
        const archiveProject = await request(
          baseURL,
          `/api/v1/projects/${cleanupProjectId}`,
          cookie,
          { method: "DELETE" },
        );
        requireStatus(archiveProject, 200, "ARCHIVE_PROJECT");
        log("document-smoke-fixture-archived", {
          projectId: cleanupProjectId,
          documentId,
        });
      });
    }
    await cleanupStep(cleanupFailures, "SIGN_OUT", async () => {
      const signOut = await jsonRequest(baseURL, "/api/auth/sign-out", cookie, "POST", {});
      requireStatus(signOut.response, 200, "SIGN_OUT");
      log("document-smoke-session-revoked");
    });
    if (cleanupFailures.length > 0) process.exitCode = 1;
  }
}

try {
  await main();
} catch (error: unknown) {
  const code =
    error instanceof AgentHostEnrollmentError
      ? error.code
      : error instanceof Error
        ? error.message
        : "UNKNOWN_ERROR";
  console.error(JSON.stringify({ status: "error", step: "document-smoke", code }));
  process.exitCode = 1;
}

process.exit(process.exitCode ?? 0);
