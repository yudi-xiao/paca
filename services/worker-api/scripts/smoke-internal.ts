export {};

type JsonRecord = Record<string, unknown>;

type HeadersWithSetCookie = Headers & {
  getSetCookie?: () => string[];
};

const expectedUserExistsCode = "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name}_NOT_CONFIGURED`);
  }
  return value;
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

function log(step: string, details: JsonRecord = {}): void {
  console.log(JSON.stringify({ status: "ok", step, ...details }));
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return null;
  }
  return response.json();
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function responseCode(value: unknown): string | null {
  const code = asRecord(value)?.code;
  return typeof code === "string" ? code : null;
}

function requireStatus(response: Response, expected: number, step: string): void {
  if (response.status !== expected) {
    throw new Error(`${step}_HTTP_${response.status}`);
  }
}

function readSessionCookie(response: Response): string {
  const headers = response.headers as HeadersWithSetCookie;
  const values = headers.getSetCookie?.() ?? [headers.get("set-cookie") ?? ""];

  for (const value of values) {
    const match = value.match(/(?:^|,\s*)([^=;,\s]*session_token)=([^;,\s]+)/i);
    if (match?.[1] && match[2]) {
      return `${match[1]}=${match[2]}`;
    }
  }

  throw new Error("SESSION_COOKIE_MISSING");
}

async function authPost(
  baseURL: string,
  path: string,
  body: JsonRecord | undefined,
  cookie?: string,
): Promise<Response> {
  const headers = new Headers({
    "content-type": "application/json",
    origin: baseURL,
  });
  if (cookie) {
    headers.set("cookie", cookie);
  }

  return fetch(`${baseURL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
    redirect: "manual",
  });
}

async function main(): Promise<void> {
  const baseURL = internalBaseURL();
  const email = requiredEnvironment("PACA_SMOKE_EMAIL");
  const password = requiredEnvironment("PACA_SMOKE_PASSWORD");
  const healthToken = requiredEnvironment("PACA_INTERNAL_HEALTH_TOKEN");
  const name = process.env.PACA_SMOKE_NAME?.trim() || "Paca Internal Tester";

  if (!email.includes("@")) {
    throw new Error("PACA_SMOKE_EMAIL_INVALID");
  }
  if (password.length < 12) {
    throw new Error("PACA_SMOKE_PASSWORD_TOO_SHORT");
  }

  const health = await fetch(`${baseURL}/health`, { redirect: "manual" });
  requireStatus(health, 200, "PUBLIC_HEALTH");
  const healthBody = asRecord(await readJson(health));
  if (healthBody?.environment !== "internal") {
    throw new Error("PUBLIC_HEALTH_WRONG_ENVIRONMENT");
  }
  log("public-health");

  const databaseHealth = await fetch(`${baseURL}/internal/health/database`, {
    headers: { authorization: `Bearer ${healthToken}` },
    redirect: "manual",
  });
  requireStatus(databaseHealth, 200, "DATABASE_HEALTH");
  log("database-health");

  const signUp = await authPost(baseURL, "/api/auth/sign-up/email", {
    email,
    name,
    password,
  });
  const signUpBody = await readJson(signUp);

  let cookie: string;
  if (signUp.ok) {
    cookie = readSessionCookie(signUp);
    log("sign-up");
  } else if (responseCode(signUpBody) === expectedUserExistsCode) {
    const signIn = await authPost(baseURL, "/api/auth/sign-in/email", {
      email,
      password,
      rememberMe: true,
    });
    requireStatus(signIn, 200, "SIGN_IN");
    cookie = readSessionCookie(signIn);
    log("sign-in-existing-user");
  } else {
    throw new Error(`SIGN_UP_${responseCode(signUpBody) ?? `HTTP_${signUp.status}`}`);
  }

  const session = await fetch(`${baseURL}/api/auth/get-session`, {
    headers: { cookie, origin: baseURL },
    redirect: "manual",
  });
  requireStatus(session, 200, "GET_SESSION");
  const sessionBody = asRecord(await readJson(session));
  const sessionUser = asRecord(sessionBody?.user);
  if (sessionUser?.email !== email) {
    throw new Error("GET_SESSION_IDENTITY_MISMATCH");
  }
  log("get-session");

  const currentUser = await fetch(`${baseURL}/api/me`, {
    headers: { cookie, origin: baseURL },
    redirect: "manual",
  });
  requireStatus(currentUser, 200, "CURRENT_USER");
  const currentUserBody = asRecord(await readJson(currentUser));
  const currentUserData = asRecord(currentUserBody?.data);
  const currentUserIdentity = asRecord(currentUserData?.user);
  if (currentUserIdentity?.email !== email) {
    throw new Error("CURRENT_USER_IDENTITY_MISMATCH");
  }
  log("current-user");

  const signOut = await authPost(baseURL, "/api/auth/sign-out", undefined, cookie);
  requireStatus(signOut, 200, "SIGN_OUT");
  log("sign-out");

  const revokedSession = await fetch(`${baseURL}/api/auth/get-session`, {
    headers: { cookie, origin: baseURL },
    redirect: "manual",
  });
  requireStatus(revokedSession, 200, "REVOKED_SESSION");
  if ((await readJson(revokedSession)) !== null) {
    throw new Error("REVOKED_SESSION_STILL_ACTIVE");
  }
  log("revoked-session-rejected");
  log("smoke-complete");
}

main().catch((error: unknown) => {
  const code = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  console.error(JSON.stringify({ status: "error", step: "smoke", code }));
  process.exitCode = 1;
});
