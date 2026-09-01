export {};

type JsonRecord = Record<string, unknown>;
type BunWebSocketConstructor = new (
  url: string,
  options: { headers: Record<string, string> },
) => WebSocket;

const DEFAULT_MESSAGE_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_MS = 12_000;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_NOT_CONFIGURED`);
  return value;
}

function optionalDuration(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 300_000) {
    throw new Error(`${name}_INVALID`);
  }
  return parsed;
}

function internalBaseURL(): string {
  const configured = new URL(requiredEnvironment("PACA_INTERNAL_BASE_URL"));
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
  const id = value.id;
  if (typeof id !== "string") throw new Error(`${step}_ID_INVALID`);
  return id;
}

function requireStatus(response: Response, expected: number, step: string): void {
  if (response.status !== expected) throw new Error(`${step}_HTTP_${response.status}`);
}

function sessionCookie(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? [headers.get("set-cookie") ?? ""];
  for (const value of values) {
    const match = value.match(/([^=;,]*session_token)=[^;,]+/i);
    if (match?.[0]) return match[0];
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
): Promise<Response> {
  return request(baseURL, path, cookie, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function parseMessage(event: MessageEvent): JsonRecord | null {
  if (typeof event.data !== "string") return null;
  try {
    return asRecord(JSON.parse(event.data));
  } catch {
    return null;
  }
}

function waitForMessage(
  socket: WebSocket,
  predicate: (message: JsonRecord) => boolean,
  timeoutCode: string,
  timeoutMs: number,
): Promise<JsonRecord> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error(timeoutCode));
    }, timeoutMs);
    const onMessage = (event: MessageEvent) => {
      const message = parseMessage(event);
      if (!message || !predicate(message)) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      resolve(message);
    };
    socket.addEventListener("message", onMessage);
  });
}

function expectNoMessage(
  socket: WebSocket,
  predicate: (message: JsonRecord) => boolean,
  errorCode: string,
  durationMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      resolve();
    }, durationMs);
    const onMessage = (event: MessageEvent) => {
      const message = parseMessage(event);
      if (!message || !predicate(message)) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      reject(new Error(errorCode));
    };
    socket.addEventListener("message", onMessage);
  });
}

async function connectProjectParty(
  baseURL: string,
  cookie: string,
  projectId: string,
  timeoutMs: number,
): Promise<WebSocket> {
  const url = new URL(baseURL);
  url.protocol = "wss:";
  url.pathname = `/ws/parties/project-party/${encodeURIComponent(projectId)}`;
  const ClientWebSocket = WebSocket as unknown as BunWebSocketConstructor;
  const socket = new ClientWebSocket(url.toString(), {
    headers: { cookie, origin: baseURL },
  });
  const opened = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("REALTIME_OPEN_TIMEOUT")), timeoutMs);
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
        reject(new Error("REALTIME_OPEN_FAILED"));
      },
      { once: true },
    );
  });
  const ready = waitForMessage(
    socket,
    (message) => message.kind === "ready" && message.roomId === projectId,
    "REALTIME_READY_TIMEOUT",
    timeoutMs,
  );
  await opened;
  await ready;
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
  socket.close(1000, "realtime smoke disconnect");
  await closed;
}

async function ping(socket: WebSocket, timeoutMs: number): Promise<void> {
  const pong = waitForMessage(
    socket,
    (message) => message.kind === "pong" && typeof message.timestamp === "number",
    "REALTIME_PONG_TIMEOUT",
    timeoutMs,
  );
  socket.send(JSON.stringify({ type: "ping" }));
  await pong;
}

async function updateAndReceive(
  baseURL: string,
  cookie: string,
  projectId: string,
  taskId: string,
  title: string,
  socket: WebSocket,
  timeoutMs: number,
): Promise<JsonRecord> {
  const delivered = waitForMessage(
    socket,
    (message) =>
      message.kind === "event" &&
      message.type === "task.updated" &&
      asRecord(message.payload)?.task_id === taskId,
    "REALTIME_TASK_EVENT_TIMEOUT",
    timeoutMs,
  );
  const update = await jsonRequest(
    baseURL,
    `/api/v1/projects/${projectId}/tasks/${taskId}`,
    cookie,
    "PATCH",
    { title },
  );
  requireStatus(update, 200, "UPDATE_TASK");
  const event = await delivered;
  if (typeof event.id !== "string") throw new Error("REALTIME_EVENT_ID_MISSING");
  return event;
}

async function main(): Promise<void> {
  const baseURL = internalBaseURL();
  const email = requiredEnvironment("PACA_REALTIME_SMOKE_EMAIL");
  const password = requiredEnvironment("PACA_REALTIME_SMOKE_PASSWORD");
  const runId = process.env.PACA_REALTIME_SMOKE_RUN_ID?.trim() || crypto.randomUUID();
  const timeoutMs = optionalDuration(
    "PACA_REALTIME_MESSAGE_TIMEOUT_MS",
    DEFAULT_MESSAGE_TIMEOUT_MS,
  );
  const idleMs = optionalDuration("PACA_REALTIME_IDLE_MS", DEFAULT_IDLE_MS);
  const duplicateWindowMs = optionalDuration("PACA_REALTIME_DUPLICATE_WINDOW_MS", 0);
  const rollingWindowMs = optionalDuration("PACA_REALTIME_ROLLING_WINDOW_MS", 0);
  if (!email.includes("@")) throw new Error("PACA_REALTIME_SMOKE_EMAIL_INVALID");
  if (password.length < 12) throw new Error("PACA_REALTIME_SMOKE_PASSWORD_TOO_SHORT");
  if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error("PACA_REALTIME_SMOKE_RUN_ID_INVALID");

  const signIn = await fetch(`${baseURL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseURL },
    body: JSON.stringify({ email, password, rememberMe: false }),
    redirect: "manual",
  });
  requireStatus(signIn, 200, "SIGN_IN");
  const cookie = sessionCookie(signIn);
  let projectId: string | null = null;
  let socket: WebSocket | null = null;

  try {
    const createProject = await jsonRequest(baseURL, "/api/v1/projects", cookie, "POST", {
      name: `Realtime smoke ${runId.slice(0, 8)}`,
      task_id_prefix: `RT${runId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    });
    requireStatus(createProject, 201, "CREATE_PROJECT");
    projectId = requireId(requireData(await createProject.json(), "CREATE_PROJECT"), "PROJECT");

    const title = `Realtime smoke task ${runId.slice(0, 8)}`;
    const createTask = await jsonRequest(
      baseURL,
      `/api/v1/projects/${projectId}/tasks`,
      cookie,
      "POST",
      { title },
    );
    requireStatus(createTask, 201, "CREATE_TASK");
    const taskId = requireId(requireData(await createTask.json(), "CREATE_TASK"), "TASK");
    log("realtime-smoke-fixture-created", { runId, projectId, taskId });

    socket = await connectProjectParty(baseURL, cookie, projectId, timeoutMs);
    log("realtime-smoke-connected", { projectId });

    const firstEvent = await updateAndReceive(
      baseURL,
      cookie,
      projectId,
      taskId,
      title,
      socket,
      timeoutMs,
    );
    const firstEventId = String(firstEvent.id);
    log("realtime-smoke-event-received", {
      projectId,
      taskId,
      outboxId: firstEventId,
      eventType: firstEvent.type,
    });

    if (duplicateWindowMs > 0) {
      log("realtime-smoke-duplicate-window", {
        projectId,
        taskId,
        outboxId: firstEventId,
        durationMs: duplicateWindowMs,
      });
      await expectNoMessage(
        socket,
        (message) => message.id === firstEventId,
        "REALTIME_DUPLICATE_DELIVERED",
        duplicateWindowMs,
      );
      log("realtime-smoke-duplicate-suppressed", { outboxId: firstEventId });
    }

    if (idleMs > 0) await delay(idleMs);
    await ping(socket, timeoutMs);
    log("realtime-smoke-idle-pong", { idleMs });

    await closeSocket(socket);
    socket = await connectProjectParty(baseURL, cookie, projectId, timeoutMs);
    const reconnectEvent = await updateAndReceive(
      baseURL,
      cookie,
      projectId,
      taskId,
      title,
      socket,
      timeoutMs,
    );
    if (reconnectEvent.id === firstEventId) throw new Error("REALTIME_RECONNECT_EVENT_ID_REUSED");
    log("realtime-smoke-reconnected", { outboxId: reconnectEvent.id });

    if (rollingWindowMs > 0) {
      log("realtime-smoke-rolling-window", { projectId, taskId, durationMs: rollingWindowMs });
      await delay(rollingWindowMs);
      if (socket.readyState !== WebSocket.OPEN) {
        await closeSocket(socket);
        socket = await connectProjectParty(baseURL, cookie, projectId, timeoutMs);
        log("realtime-smoke-post-deploy-reconnected");
      }
      await ping(socket, timeoutMs);
      const rollingEvent = await updateAndReceive(
        baseURL,
        cookie,
        projectId,
        taskId,
        title,
        socket,
        timeoutMs,
      );
      log("realtime-smoke-post-deploy-event", { outboxId: rollingEvent.id });
    }

    log("realtime-smoke-complete", { runId, projectId, taskId });
  } finally {
    try {
      await closeSocket(socket);
      if (projectId) {
        const removeProject = await request(baseURL, `/api/v1/projects/${projectId}`, cookie, {
          method: "DELETE",
        });
        requireStatus(removeProject, 200, "DELETE_PROJECT");
        log("realtime-smoke-fixture-archived", { projectId });
      }
    } finally {
      const signOut = await jsonRequest(baseURL, "/api/auth/sign-out", cookie, "POST", {});
      requireStatus(signOut, 200, "SIGN_OUT");
      log("realtime-smoke-session-revoked");
    }
  }
}

try {
  await main();
} catch (error: unknown) {
  const code = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  console.error(JSON.stringify({ status: "error", step: "realtime-smoke", code }));
  process.exitCode = 1;
}

process.exit(process.exitCode ?? 0);
