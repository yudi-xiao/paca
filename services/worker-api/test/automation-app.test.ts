import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import type { AutomationRuntime } from "../src/automation/runtime";
import type { AppBindings } from "../src/bindings";

const projectId = "6bdb7f3a-e59d-4826-8383-0104192157a8";
const automationId = "c9d8cdf1-b208-4c87-b71f-cf4cdf2d373a";
const runId = "19206016-4da7-4b97-a4f9-71df19a6cf6b";
const nodeId = "35a9618f-6c20-4aac-a41a-9e8dfa5ca4bb";
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
    listRuns: vi.fn(async () => [
      {
        id: runId,
        automationId,
        triggerNodeId: nodeId,
        taskId: null,
        eventKey: "task-created:event-1",
        graphVersion: 1,
        graphSnapshot: { secret: "must not be returned" },
        status: "completed" as const,
        startedAt: now,
        finishedAt: now,
      },
    ]),
    listRunSteps: vi.fn(async () => [
      {
        id: "e9b1d57c-186a-485e-8bb3-f3a8d498fd62",
        runId,
        nodeId,
        stepKey: "step-1",
        status: "completed" as const,
        inputSnapshot: null,
        outputSnapshot: { updated: true },
        errorCode: null,
        executedAt: now,
      },
    ]),
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

  it("reads bounded run history and scoped steps without exposing internal event keys", async () => {
    const automations = runtime();
    const authorizeProjectPermission = authorize();
    const app = createApp({ automations, authorizeProjectPermission, log: vi.fn() });
    const runs = await app.request(
      `/api/v1/projects/${projectId}/automations/${automationId}/runs?limit=10`,
      {},
      bindings(),
    );
    expect(runs.status).toBe(200);
    expect(automations.listRuns).toHaveBeenCalledWith(
      expect.anything(),
      projectId,
      automationId,
      10,
    );
    const runsBody = await runs.json();
    expect(runsBody).toMatchObject({
      data: { items: [{ id: runId, status: "completed" }] },
    });
    expect(JSON.stringify(runsBody)).not.toContain("must not be returned");
    expect(JSON.stringify(runsBody)).not.toContain("task-created:event-1");

    const steps = await app.request(
      `/api/v1/projects/${projectId}/automations/${automationId}/runs/${runId}/steps`,
      {},
      bindings(),
    );
    expect(steps.status).toBe(200);
    expect(automations.listRunSteps).toHaveBeenCalledWith(
      expect.anything(),
      projectId,
      automationId,
      runId,
    );
    await expect(steps.json()).resolves.toMatchObject({
      data: { items: [{ run_id: runId, status: "completed", output_snapshot: { updated: true } }] },
    });
    expect(authorizeProjectPermission).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      projectId,
      { workflows: ["read"] },
    );

    const invalid = await app.request(
      `/api/v1/projects/${projectId}/automations/${automationId}/runs?limit=101`,
      {},
      bindings(),
    );
    expect(invalid.status).toBe(400);
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
