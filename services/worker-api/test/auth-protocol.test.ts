import { type MemoryDB, memoryAdapter } from "@better-auth/memory-adapter";
import { betterAuth } from "better-auth/minimal";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import { createAuthOptions, readTrustedOrigins } from "../src/auth/runtime";
import type { AppBindings } from "../src/bindings";

const BASE_URL = "https://auth.paca.test";
const TEST_SECRET = "test-only-secret-that-is-longer-than-thirty-two-characters";

function testBindings(overrides: Partial<AppBindings> = {}): AppBindings {
  return {
    BETTER_AUTH_SECRET: TEST_SECRET,
    BETTER_AUTH_URL: BASE_URL,
    ENVIRONMENT: "test",
    TRUSTED_ORIGINS: BASE_URL,
    ...overrides,
  } as AppBindings;
}

function createMemoryDatabase(): MemoryDB {
  return {
    account: [],
    invitation: [],
    member: [],
    organization: [],
    session: [],
    user: [],
    verification: [],
  };
}

function sessionCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error("Expected Better Auth to set a session cookie");
  }

  const match = setCookie.match(/(?:^|,\s*)([^=;,]*session_token)=[^;,]+/i);
  if (!match?.[0]) {
    throw new Error("Expected a Better Auth session_token cookie");
  }

  return match[0].replace(/^,\s*/, "").split(";")[0] ?? "";
}

function jsonRequest(body: Record<string, unknown>): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: BASE_URL,
    },
    body: JSON.stringify(body),
  };
}

describe("Better Auth protocol", () => {
  it("serves Agent Auth discovery from the standard well-known route", async () => {
    const bindings = testBindings();
    const database = createMemoryDatabase();
    const auth = betterAuth(createAuthOptions(memoryAdapter(database), bindings));
    const app = createApp({
      authHandler: (request) => auth.handler(request),
      agentConfigurationHandler: async () => Response.json(await auth.api.getAgentConfiguration()),
      log: vi.fn(),
    });

    const response = await app.request(
      `${BASE_URL}/.well-known/agent-configuration`,
      undefined,
      bindings,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      provider_name: "Paca",
      modes: ["delegated"],
      approval_methods: ["device_authorization"],
    });
  });

  it("completes sign-up, session lookup, sign-out, and server-side revocation", async () => {
    const bindings = testBindings();
    const database = createMemoryDatabase();
    const auth = betterAuth(createAuthOptions(memoryAdapter(database), bindings));
    const app = createApp({ authHandler: (request) => auth.handler(request), log: vi.fn() });

    const signUp = await app.request(
      `${BASE_URL}/api/auth/sign-up/email`,
      jsonRequest({
        email: "internal-tester@paca.test",
        name: "Internal Tester",
        password: "correct-horse-battery-staple",
      }),
      bindings,
    );

    expect(signUp.status).toBe(200);
    expect(signUp.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(signUp.headers.get("set-cookie")).toMatch(/Secure/i);
    expect(signUp.headers.get("set-cookie")).toMatch(/SameSite=Lax/i);
    expect(signUp.headers.get("access-control-allow-origin")).toBe(BASE_URL);
    const cookie = sessionCookie(signUp);

    const currentSession = await app.request(
      `${BASE_URL}/api/auth/get-session`,
      { headers: { cookie, origin: BASE_URL } },
      bindings,
    );
    expect(currentSession.status).toBe(200);
    await expect(currentSession.json()).resolves.toMatchObject({
      user: { email: "internal-tester@paca.test" },
    });

    const signOut = await app.request(
      `${BASE_URL}/api/auth/sign-out`,
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json", origin: BASE_URL },
        body: "{}",
      },
      bindings,
    );
    expect(signOut.status).toBe(200);

    const revokedSession = await app.request(
      `${BASE_URL}/api/auth/get-session`,
      { headers: { cookie, origin: BASE_URL } },
      bindings,
    );
    expect(revokedSession.status).toBe(200);
    await expect(revokedSession.json()).resolves.toBeNull();
    expect(database.session).toHaveLength(0);
  });

  it("enforces the configured minimum password length", async () => {
    const bindings = testBindings();
    const database = createMemoryDatabase();
    const auth = betterAuth(createAuthOptions(memoryAdapter(database), bindings));
    const app = createApp({ authHandler: (request) => auth.handler(request), log: vi.fn() });

    const response = await app.request(
      `${BASE_URL}/api/auth/sign-up/email`,
      jsonRequest({
        email: "short-password@paca.test",
        name: "Short Password",
        password: "too-short",
      }),
      bindings,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "PASSWORD_TOO_SHORT" });
    expect(database.user).toHaveLength(0);
  });

  it("rejects a cookie-authenticated mutation without a trusted origin", async () => {
    const bindings = testBindings();
    const auth = betterAuth(createAuthOptions(memoryAdapter(createMemoryDatabase()), bindings));
    const app = createApp({ authHandler: (request) => auth.handler(request), log: vi.fn() });
    const signUp = await app.request(
      `${BASE_URL}/api/auth/sign-up/email`,
      jsonRequest({
        email: "csrf-check@paca.test",
        name: "CSRF Check",
        password: "correct-horse-battery-staple",
      }),
      bindings,
    );
    const cookie = sessionCookie(signUp);

    const response = await app.request(
      `${BASE_URL}/api/auth/sign-out`,
      {
        method: "POST",
        headers: { cookie },
      },
      bindings,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "MISSING_ORIGIN" });
  });

  it("rejects insecure remote auth URLs and non-origin trusted entries", () => {
    expect(() =>
      createAuthOptions(
        memoryAdapter(createMemoryDatabase()),
        testBindings({ BETTER_AUTH_URL: "http://auth.paca.test" }),
      ),
    ).toThrowError("BETTER_AUTH_URL_INSECURE");

    expect(() =>
      readTrustedOrigins(testBindings({ TRUSTED_ORIGINS: "https://app.paca.test/path" })),
    ).toThrowError("TRUSTED_ORIGIN_INVALID");
  });
});
