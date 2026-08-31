export {};

type JsonRecord = Record<string, unknown>;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_NOT_CONFIGURED`);
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

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function requireStatus(response: Response, expected: number, step: string): void {
  if (response.status !== expected) throw new Error(`${step}_HTTP_${response.status}`);
}

function sessionCookie(response: Response): string {
  const value = response.headers.get("set-cookie") ?? "";
  const match = value.match(/([^=;,]*session_token)=[^;,]+/i);
  if (!match?.[0]) throw new Error("SESSION_COOKIE_MISSING");
  return match[0];
}

async function authPost(
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

function log(step: string, details: JsonRecord = {}): void {
  console.log(JSON.stringify({ status: "ok", step, ...details }));
}

async function main(): Promise<void> {
  const baseURL = internalBaseURL();
  const runId = crypto.randomUUID();
  const email = `permission-smoke-${runId}@paca.test`;
  const password = `Paca-${crypto.randomUUID()}-Aa1!`;

  const signUp = await authPost(baseURL, "/api/auth/sign-up/email", {
    email,
    name: "Paca Permission Smoke",
    password,
  });
  requireStatus(signUp, 200, "SIGN_UP");
  const cookie = sessionCookie(signUp);
  log("sign-up-and-provision");

  const session = await fetch(`${baseURL}/api/auth/get-session`, {
    headers: { cookie, origin: baseURL },
  });
  requireStatus(session, 200, "GET_SESSION");
  const sessionBody = asRecord(await session.json());
  const sessionData = asRecord(sessionBody?.session);
  if (sessionData?.activeOrganizationId !== "paca-default") {
    throw new Error("DEFAULT_ORGANIZATION_NOT_ACTIVE");
  }
  log("default-organization-active");

  const legacyPermissions = await fetch(`${baseURL}/api/v1/users/me/global-permissions`, {
    headers: { cookie, origin: baseURL },
  });
  requireStatus(legacyPermissions, 200, "LEGACY_PERMISSIONS");
  const legacyBody = asRecord(await legacyPermissions.json());
  const legacyData = asRecord(legacyBody?.data);
  const permissions = legacyData?.permissions;
  if (
    !Array.isArray(permissions) ||
    !permissions.includes("users.read") ||
    permissions.includes("*")
  ) {
    throw new Error("ORDINARY_USER_PERMISSION_PROJECTION_INVALID");
  }
  log("legacy-permission-projection");

  const allowed = await authPost(
    baseURL,
    "/api/auth/paca-permission/has-system-permission",
    { permissions: { users: ["read"] } },
    cookie,
  );
  requireStatus(allowed, 200, "PLUGIN_ALLOWED");
  if (asRecord(await allowed.json())?.allowed !== true) {
    throw new Error("PLUGIN_EXPECTED_ALLOW");
  }

  const denied = await authPost(
    baseURL,
    "/api/auth/paca-permission/has-system-permission",
    { permissions: { settings: ["write"] } },
    cookie,
  );
  requireStatus(denied, 200, "PLUGIN_DENIED");
  if (asRecord(await denied.json())?.allowed !== false) {
    throw new Error("PLUGIN_EXPECTED_DENY");
  }
  log("plugin-allow-and-deny");

  const signOut = await authPost(baseURL, "/api/auth/sign-out", {}, cookie);
  requireStatus(signOut, 200, "SIGN_OUT");

  const revoked = await authPost(
    baseURL,
    "/api/auth/paca-permission/has-system-permission",
    { permissions: { users: ["read"] } },
    cookie,
  );
  requireStatus(revoked, 401, "REVOKED_PLUGIN_SESSION");
  log("revoked-session-rejected");
  log("permission-smoke-complete", { cleanupEmail: email });
}

main().catch((error: unknown) => {
  const code = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  console.error(JSON.stringify({ status: "error", step: "permission-smoke", code }));
  process.exitCode = 1;
});
