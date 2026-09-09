import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import type { AppBindings } from "../src/bindings";
import type { EnvironmentRuntime } from "../src/environment/runtime";
import {
  type EnvironmentResource,
  EnvironmentResourceError,
  environmentResourceErrorCodes,
} from "../src/environment/service";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-09T08:00:00.000Z");

const environment: EnvironmentResource = {
  id: ENVIRONMENT_ID,
  projectId: PROJECT_ID,
  name: "Primary sandbox",
  backend: "cloudflare-sandbox",
  createdBy: "user-1",
  createdAt: NOW,
  updatedAt: NOW,
};

function bindings(): AppBindings {
  return { ENVIRONMENT: "test" } as AppBindings;
}

function authorize() {
  return vi.fn(async () => ({
    authenticated: true as const,
    userId: "user-1",
    decision: {
      scopeExists: true,
      allowed: true,
      grants: [{ resource: "environments" as const, action: "*" }],
    },
  }));
}

function runtime(overrides: Partial<EnvironmentRuntime> = {}): EnvironmentRuntime {
  return {
    list: async () => [environment],
    get: async () => environment,
    create: async () => environment,
    update: async () => environment,
    archive: async () => undefined,
    connectUser: async () => {
      throw new Error("not implemented in resource test");
    },
    ...overrides,
  };
}

describe("environment resource HTTP contract", () => {
  it("lists on-demand environments behind environments.read without provider secrets", async () => {
    const list = vi.fn(runtime().list);
    const authorizeProjectPermission = authorize();
    const app = createApp({
      authorizeProjectPermission,
      environments: runtime({ list }),
      log: vi.fn(),
    });

    const response = await app.request(
      `/api/v1/projects/${PROJECT_ID}/environments`,
      {},
      bindings(),
    );

    expect(response.status).toBe(200);
    expect(authorizeProjectPermission).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      PROJECT_ID,
      { environments: ["read"] },
    );
    expect(list).toHaveBeenCalledWith(expect.anything(), PROJECT_ID);
    const body = await response.json();
    expect(body).toMatchObject({
      success: true,
      data: {
        environments: [
          {
            id: ENVIRONMENT_ID,
            project_id: PROJECT_ID,
            name: "Primary sandbox",
            status: "ready_on_demand",
            backend: "cloudflare-sandbox",
            created_by: "user-1",
          },
        ],
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/gateway_reference|access_token|secret/i);
  });

  it("creates only the user-controlled name behind environments.write", async () => {
    const create = vi.fn(runtime().create);
    const authorizeProjectPermission = authorize();
    const app = createApp({
      authorizeProjectPermission,
      environments: runtime({ create }),
      log: vi.fn(),
    });

    const response = await app.request(
      `/api/v1/projects/${PROJECT_ID}/environments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Primary sandbox" }),
      },
      bindings(),
    );

    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith(expect.anything(), PROJECT_ID, "user-1", {
      name: "Primary sandbox",
    });
    expect(authorizeProjectPermission).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      PROJECT_ID,
      { environments: ["write"] },
    );

    const rejected = await app.request(
      `/api/v1/projects/${PROJECT_ID}/environments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Unsafe", backend: "cloudflare-computer" }),
      },
      bindings(),
    );
    expect(rejected.status).toBe(400);
    expect(create).toHaveBeenCalledOnce();
  });

  it("gets, renames and archives an environment through project-scoped routes", async () => {
    const get = vi.fn(runtime().get);
    const update = vi.fn(runtime().update);
    const archive = vi.fn(runtime().archive);
    const app = createApp({
      authorizeProjectPermission: authorize(),
      environments: runtime({ get, update, archive }),
      log: vi.fn(),
    });

    const detail = await app.request(
      `/api/v1/projects/${PROJECT_ID}/environments/${ENVIRONMENT_ID}`,
      {},
      bindings(),
    );
    expect(detail.status).toBe(200);
    expect(get).toHaveBeenCalledWith(expect.anything(), PROJECT_ID, ENVIRONMENT_ID);

    const renamed = await app.request(
      `/api/v1/projects/${PROJECT_ID}/environments/${ENVIRONMENT_ID}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Renamed" }),
      },
      bindings(),
    );
    expect(renamed.status).toBe(200);
    expect(update).toHaveBeenCalledWith(expect.anything(), PROJECT_ID, ENVIRONMENT_ID, {
      name: "Renamed",
    });

    const archived = await app.request(
      `/api/v1/projects/${PROJECT_ID}/environments/${ENVIRONMENT_ID}`,
      { method: "DELETE" },
      bindings(),
    );
    expect(archived.status).toBe(204);
    expect(archive).toHaveBeenCalledWith(expect.anything(), PROJECT_ID, ENVIRONMENT_ID);
  });

  it("issues a user-scoped terminal ticket only after Session and environments.connect checks", async () => {
    const expiresAt = new Date(NOW.getTime() + 30_000);
    const connectUser = vi.fn<EnvironmentRuntime["connectUser"]>(async () => ({
      protocolVersion: "paca.environment.connection.v1",
      requestId: "33333333-3333-4333-8333-333333333333",
      environmentId: ENVIRONMENT_ID,
      operationMode: "execute",
      transport: "websocket",
      url: "wss://paca-env.howlearnwood.com/v1/connect",
      accessToken: "short-lived-ticket",
      expiresAt,
    }));
    const authorizeProjectPermission = authorize();
    const app = createApp({
      authorizeProjectPermission,
      currentUserSession: async () => ({
        id: "session-1",
        user: {
          id: "user-1",
          name: "Test user",
          email: "user@example.test",
          emailVerified: true,
          image: null,
          createdAt: NOW.toISOString(),
        },
        expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      }),
      environments: runtime({ connectUser }),
      log: vi.fn(),
    });

    const response = await app.request(
      `/api/v1/projects/${PROJECT_ID}/environments/${ENVIRONMENT_ID}/terminal-ticket`,
      { method: "POST" },
      bindings(),
    );
    expect(response.status).toBe(200);
    expect(authorizeProjectPermission).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      PROJECT_ID,
      { environments: ["connect"] },
    );
    expect(connectUser).toHaveBeenCalledWith(
      expect.anything(),
      PROJECT_ID,
      ENVIRONMENT_ID,
      "user-1",
      new Date(NOW.getTime() + 60_000),
    );
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        ticket: "short-lived-ticket",
        ws_url: "wss://paca-env.howlearnwood.com/v1/connect",
        expires_at: expiresAt.toISOString(),
      },
    });
  });

  it("maps resource conflicts and rejects malformed ids before the runtime", async () => {
    const create = vi.fn<EnvironmentRuntime["create"]>(async () => {
      throw new EnvironmentResourceError(environmentResourceErrorCodes.nameTaken);
    });
    const get = vi.fn(runtime().get);
    const app = createApp({
      authorizeProjectPermission: authorize(),
      environments: runtime({ create, get }),
      log: vi.fn(),
    });

    const conflict = await app.request(
      `/api/v1/projects/${PROJECT_ID}/environments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Primary sandbox" }),
      },
      bindings(),
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error_code: environmentResourceErrorCodes.nameTaken,
    });

    const malformed = await app.request(
      `/api/v1/projects/${PROJECT_ID}/environments/not-a-uuid`,
      {},
      bindings(),
    );
    expect(malformed.status).toBe(400);
    expect(get).not.toHaveBeenCalled();
  });

  it("returns a retryable server status when the archive revocation barrier fails", async () => {
    const archive = vi.fn<EnvironmentRuntime["archive"]>(async () => {
      throw new EnvironmentResourceError(environmentResourceErrorCodes.revocationFailed);
    });
    const app = createApp({
      authorizeProjectPermission: authorize(),
      environments: runtime({ archive }),
      log: vi.fn(),
    });

    const response = await app.request(
      `/api/v1/projects/${PROJECT_ID}/environments/${ENVIRONMENT_ID}`,
      { method: "DELETE" },
      bindings(),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error_code: environmentResourceErrorCodes.revocationFailed,
    });
  });
});
