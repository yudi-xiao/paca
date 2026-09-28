import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import type { AutomationRuntime } from "../src/automation/runtime";
import type { AppBindings } from "../src/bindings";

const projectId = "6bdb7f3a-e59d-4826-8383-0104192157a8";
const automationId = "c9d8cdf1-b208-4c87-b71f-cf4cdf2d373a";
const now = new Date("2026-09-28T00:00:00.000Z");
const automation = {
  id: automationId,
  projectId,
  name: "Review tasks",
  description: "",
  status: "inactive" as const,
  graphVersion: 1,
  createdBy: "user-1",
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
};

function bindings(): AppBindings {
  return { ENVIRONMENT: "test" } as AppBindings;
}

function runtime(): AutomationRuntime {
  return {
    list: vi.fn(async () => [automation]),
    create: vi.fn(async () => automation),
    getGraph: vi.fn(async () => ({ automation, nodes: [], edges: [] })),
    update: vi.fn(async () => automation),
    archive: vi.fn(async () => undefined),
    addNode: vi.fn(),
    updateNode: vi.fn(),
    removeNode: vi.fn(),
    addEdge: vi.fn(),
    removeEdge: vi.fn(),
  };
}

function authorize(allowed = true) {
  return vi.fn(async () => ({
    authenticated: true as const,
    userId: "user-1",
    decision: {
      scopeExists: true,
      allowed,
      grants: [{ resource: "workflows" as const, action: "*" }],
    },
  }));
}

describe("Automation draft graph HTTP boundary", () => {
  it("lists project graphs under workflows.read and preserves the web contract", async () => {
    const automations = runtime();
    const authorizeProjectPermission = authorize();
    const app = createApp({ automations, authorizeProjectPermission, log: vi.fn() });
    const response = await app.request(
      `/api/v1/projects/${projectId}/automations?status=inactive`,
      {},
      bindings(),
    );

    expect(response.status).toBe(200);
    expect(authorizeProjectPermission).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      projectId,
      { workflows: ["read"] },
    );
    expect(automations.list).toHaveBeenCalledWith(expect.anything(), projectId, "inactive");
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { items: [{ id: automationId, project_id: projectId, status: "inactive" }] },
    });
  });

  it("uses the trusted permission actor for creation and rejects denied writes", async () => {
    const automations = runtime();
    const app = createApp({ automations, authorizeProjectPermission: authorize(), log: vi.fn() });
    const response = await app.request(
      `/api/v1/projects/${projectId}/automations`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Review tasks" }),
      },
      bindings(),
    );
    expect(response.status).toBe(201);
    expect(automations.create).toHaveBeenCalledWith(expect.anything(), {
      projectId,
      actorUserId: "user-1",
      name: "Review tasks",
    });

    const denied = runtime();
    const deniedApp = createApp({
      automations: denied,
      authorizeProjectPermission: authorize(false),
      log: vi.fn(),
    });
    const deniedResponse = await deniedApp.request(
      `/api/v1/projects/${projectId}/automations`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Review tasks" }),
      },
      bindings(),
    );
    expect(deniedResponse.status).toBe(403);
    expect(denied.create).not.toHaveBeenCalled();
  });

  it("keeps activation unavailable while the reliable executor is absent", async () => {
    const app = createApp({
      automations: runtime(),
      authorizeProjectPermission: authorize(),
      log: vi.fn(),
    });
    const response = await app.request(
      `/api/v1/projects/${projectId}/automations/${automationId}/activate`,
      { method: "POST" },
      bindings(),
    );
    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toMatchObject({
      code: "API_DOMAIN_NOT_MIGRATED",
      domain: "automations",
    });
  });
});
