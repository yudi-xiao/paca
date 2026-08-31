import { type MemoryDB, memoryAdapter } from "@better-auth/memory-adapter";
import { betterAuth } from "better-auth/minimal";
import { describe, expect, it, vi } from "vitest";

import { createAuthOptions } from "../src/auth/runtime";
import type { AppBindings } from "../src/bindings";
import { pacaPermission } from "../src/permission/plugin";
import { PacaPermissionService, type PacaPermissionStore } from "../src/permission/service";

const BASE_URL = "https://auth.paca.test";
const TEST_SECRET = "test-only-secret-that-is-longer-than-thirty-two-characters";

function testBindings(): AppBindings {
  return {
    BETTER_AUTH_SECRET: TEST_SECRET,
    BETTER_AUTH_URL: BASE_URL,
    ENVIRONMENT: "test",
    TRUSTED_ORIGINS: BASE_URL,
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

function store(overrides: Partial<PacaPermissionStore> = {}): PacaPermissionStore {
  return {
    listSystemGrants: async () => [{ resource: "*", action: "*" }],
    listOrganizationGrants: async () => [],
    listProjectGrants: async () => [],
    organizationExists: async () => true,
    findProjectOrganization: async () => "organization-1",
    ...overrides,
  };
}

function sessionCookie(response: Response): string {
  const value = response.headers.get("set-cookie") ?? "";
  const match = value.match(/([^=;,]*session_token)=[^;,]+/i);
  if (!match?.[0]) throw new Error("Expected a session cookie");
  return match[0];
}

async function signedInAuth(permissionStore: PacaPermissionStore) {
  const bindings = testBindings();
  const auth = betterAuth(
    createAuthOptions(
      memoryAdapter(createMemoryDatabase()),
      bindings,
      pacaPermission({ service: new PacaPermissionService(permissionStore) }),
    ),
  );
  const response = await auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({
        email: "permission-tester@paca.test",
        name: "Permission Tester",
        password: "correct-horse-battery-staple",
      }),
    }),
  );
  expect(response.status).toBe(200);
  return { auth, cookie: sessionCookie(response) };
}

function permissionRequest(
  cookie?: string,
  permissions: Record<string, string[]> = { users: ["read"] },
) {
  const headers = new Headers({ "content-type": "application/json", origin: BASE_URL });
  if (cookie) headers.set("cookie", cookie);
  return new Request(`${BASE_URL}/api/auth/paca-permission/has-system-permission`, {
    method: "POST",
    headers,
    body: JSON.stringify({ permissions }),
  });
}

describe("pacaPermission Better Auth plugin", () => {
  it("runs the default workspace provisioner after sign-up", async () => {
    const provisionUser = vi.fn(async () => undefined);
    const bindings = testBindings();
    const auth = betterAuth(
      createAuthOptions(
        memoryAdapter(createMemoryDatabase()),
        bindings,
        pacaPermission({ service: new PacaPermissionService(store()), provisionUser }),
      ),
    );

    const response = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({
          email: "provision-tester@paca.test",
          name: "Provision Tester",
          password: "correct-horse-battery-staple",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(provisionUser).toHaveBeenCalledOnce();
    expect(provisionUser).toHaveBeenCalledWith(expect.any(String), expect.any(String));
  });

  it("exposes an authenticated system permission decision endpoint", async () => {
    const { auth, cookie } = await signedInAuth(store());
    const response = await auth.handler(permissionRequest(cookie));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ allowed: true });
  });

  it("rejects requests without a Better Auth session", async () => {
    const { auth } = await signedInAuth(store());
    const response = await auth.handler(permissionRequest());

    expect(response.status).toBe(401);
  });

  it("returns a client error for a resource outside the system scope", async () => {
    const { auth, cookie } = await signedInAuth(store());
    const response = await auth.handler(permissionRequest(cookie, { tasks: ["read"] }));

    expect(response.status).toBe(400);
  });

  it("does not misreport storage failures as invalid permission requests", async () => {
    const { auth, cookie } = await signedInAuth(
      store({
        listSystemGrants: async () => {
          throw new Error("database unavailable");
        },
      }),
    );
    const response = await auth.handler(permissionRequest(cookie));

    expect(response.status).toBe(500);
  });
});
