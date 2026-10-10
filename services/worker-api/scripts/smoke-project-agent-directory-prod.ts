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

async function authPost(baseUrl: string, path: string, body: JsonRecord, cookie?: string) {
  const headers = new Headers({ "content-type": "application/json", origin: baseUrl });
  if (cookie) headers.set("cookie", cookie);
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    redirect: "manual",
  });
}

const baseUrl = new URL(required("PACA_AGENT_DIRECTORY_SMOKE_BASE_URL")).origin;
const email = required("PACA_AGENT_DIRECTORY_SMOKE_EMAIL");
const password = required("PACA_AGENT_DIRECTORY_SMOKE_PASSWORD");
const projectId = required("PACA_AGENT_DIRECTORY_SMOKE_PROJECT_ID");
const path = `/api/v1/projects/${encodeURIComponent(projectId)}/agents`;

const health = await fetch(`${baseUrl}/health`, { redirect: "manual" });
if (health.status !== 200) throw new Error(`PUBLIC_HEALTH_HTTP_${health.status}`);

const spa = await fetch(`${baseUrl}/projects/${encodeURIComponent(projectId)}/agents`, {
  redirect: "manual",
});
if (spa.status !== 200 || !(spa.headers.get("content-type") ?? "").includes("text/html")) {
  throw new Error(`PROJECT_AGENT_SPA_HTTP_${spa.status}`);
}

const unauthenticated = await fetch(`${baseUrl}${path}`, { redirect: "manual" });
if (unauthenticated.status !== 401) {
  throw new Error(`PROJECT_AGENT_UNAUTHENTICATED_HTTP_${unauthenticated.status}`);
}

const signIn = await authPost(baseUrl, "/api/auth/sign-in/email", {
  email,
  password,
  rememberMe: false,
});
if (signIn.status !== 200) throw new Error(`SIGN_IN_HTTP_${signIn.status}`);
const cookie = sessionCookie(signIn);

try {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { cookie, origin: baseUrl },
    redirect: "manual",
  });
  if (response.status !== 200) {
    throw new Error(`PROJECT_AGENT_DIRECTORY_HTTP_${response.status}`);
  }
  const body = record(await response.json());
  const data = record(body?.data);
  const items = Array.isArray(data?.items) ? data.items : null;
  if (!items || items.length === 0) {
    throw new Error("PROJECT_AGENT_DIRECTORY_EMPTY");
  }
  const serialized = JSON.stringify(items);
  if (/public_key|constraints|token|secret/i.test(serialized)) {
    throw new Error("PROJECT_AGENT_DIRECTORY_SECRET_FIELD_EXPOSED");
  }
  const statuses = items.map((item) => record(item)?.authorization_status);
  if (statuses.some((status) => !["active", "pending", "inactive"].includes(String(status)))) {
    throw new Error("PROJECT_AGENT_DIRECTORY_STATUS_INVALID");
  }

  console.log(
    JSON.stringify({
      status: "ok",
      step: "project-agent-directory-remote-smoke",
      spa: 200,
      unauthenticated: 401,
      agents: items.length,
      active: statuses.filter((status) => status === "active").length,
      pending: statuses.filter((status) => status === "pending").length,
      inactive: statuses.filter((status) => status === "inactive").length,
    }),
  );
} finally {
  await authPost(baseUrl, "/api/auth/sign-out", {}, cookie);
}
