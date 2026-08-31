export {};

type JsonRecord = Record<string, unknown>;
type HeadersWithSetCookie = Headers & { getSetCookie?: () => string[] };

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
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json", origin: baseURL });
  if (cookie) headers.set("cookie", cookie);
  return fetch(`${baseURL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    redirect: "manual",
  });
}

async function main(): Promise<void> {
  const baseURL = new URL(
    process.env.PACA_INTERNAL_BASE_URL?.trim() || "https://paca.howlearnwood.com",
  ).origin;
  const email = required("PACA_APPROVER_EMAIL");
  const password = required("PACA_APPROVER_PASSWORD");
  const agentId = required("PACA_AGENT_ID");
  const userCode = required("PACA_AGENT_USER_CODE");

  const signIn = await post(baseURL, "/api/auth/sign-in/email", {
    email,
    password,
    rememberMe: false,
  });
  const signInBody = await jsonOrNull(signIn);
  if (!signIn.ok) {
    throw new Error(responseCode(signInBody, `SIGN_IN_HTTP_${signIn.status}`));
  }
  const cookie = sessionCookie(signIn);

  try {
    const approval = await post(
      baseURL,
      "/api/auth/agent/approve-capability",
      { agent_id: agentId, user_code: userCode, action: "approve" },
      cookie,
    );
    const body = await jsonOrNull(approval);
    if (!approval.ok) {
      throw new Error(responseCode(body, `APPROVAL_HTTP_${approval.status}`));
    }
    const record = asRecord(body);
    if (record?.status !== "approved") throw new Error("APPROVAL_RESPONSE_INVALID");
    console.log(JSON.stringify({ status: "approved", agentId }));
  } finally {
    await post(baseURL, "/api/auth/sign-out", {}, cookie).catch(() => null);
  }
}

main().catch((error: unknown) => {
  const code = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  console.error(JSON.stringify({ status: "error", step: "agent-approval", code }));
  process.exitCode = 1;
});
