export {};

type JsonRecord = Record<string, unknown>;
type HeadersWithSetCookie = Headers & { getSetCookie?: () => string[] };

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_NOT_CONFIGURED`);
  return value;
}

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
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

async function request(
  baseUrl: string,
  path: string,
  method: "GET" | "PATCH" | "POST",
  cookie?: string,
  body?: JsonRecord,
): Promise<Response> {
  const headers = new Headers({ origin: baseUrl });
  if (cookie) headers.set("cookie", cookie);
  if (body) headers.set("content-type", "application/json");
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
}

const baseUrl = new URL(required("PACA_NOTIFICATION_SMOKE_BASE_URL")).origin;
const email = required("PACA_NOTIFICATION_SMOKE_EMAIL");
const password = required("PACA_NOTIFICATION_SMOKE_PASSWORD");
const path = "/api/v1/users/me/notifications";

const unauthenticated = await request(baseUrl, path, "GET");
if (unauthenticated.status !== 401 || unauthenticated.headers.get("cache-control") !== "no-store") {
  throw new Error(`NOTIFICATION_UNAUTHENTICATED_HTTP_${unauthenticated.status}`);
}

const signIn = await request(baseUrl, "/api/auth/sign-in/email", "POST", undefined, {
  email,
  password,
  rememberMe: false,
});
if (signIn.status !== 200) throw new Error(`SIGN_IN_HTTP_${signIn.status}`);
const cookie = sessionCookie(signIn);

try {
  const list = await request(baseUrl, `${path}?page_size=1`, "GET", cookie);
  if (list.status !== 200 || list.headers.get("cache-control") !== "no-store") {
    throw new Error(`NOTIFICATION_LIST_HTTP_${list.status}`);
  }
  const envelope = record(await list.json());
  const data = record(envelope?.data);
  const items = data?.items;
  const unreadCount = data?.unread_count;
  if (!Array.isArray(items) || typeof unreadCount !== "number") {
    throw new Error("NOTIFICATION_LIST_CONTRACT_INVALID");
  }

  const invalidCursor = await request(baseUrl, `${path}?cursor=invalid`, "GET", cookie);
  if (invalidCursor.status !== 400) {
    throw new Error(`NOTIFICATION_CURSOR_HTTP_${invalidCursor.status}`);
  }

  const hidden = await request(baseUrl, `${path}/${crypto.randomUUID()}/read`, "PATCH", cookie);
  if (hidden.status !== 404) throw new Error(`NOTIFICATION_HIDDEN_HTTP_${hidden.status}`);

  let readAll: number | "skipped-nonzero" = "skipped-nonzero";
  if (unreadCount === 0) {
    const response = await request(baseUrl, `${path}/read-all`, "POST", cookie);
    if (response.status !== 204) throw new Error(`NOTIFICATION_READ_ALL_HTTP_${response.status}`);
    readAll = response.status;
  }

  console.log(
    JSON.stringify({
      status: "ok",
      step: "notification-remote-smoke",
      unauthenticated: unauthenticated.status,
      list: list.status,
      items: items.length,
      invalidCursor: invalidCursor.status,
      hidden: hidden.status,
      readAll,
    }),
  );
} finally {
  await request(baseUrl, "/api/auth/sign-out", "POST", cookie, {}).catch(() => null);
}
