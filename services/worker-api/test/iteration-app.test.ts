import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import type { AppBindings } from "../src/bindings";
import type { IterationRuntime } from "../src/iteration/runtime";
import type { Sprint, TaskView } from "../src/iteration/service";

const projectId = "6bdb7f3a-e59d-4826-8383-0104192157a8";
const sprintId = "01bd76a4-263b-4a1e-940d-b9a81760ff0c";
const viewId = "89d6d6e9-b50a-4c06-8fc9-74d8e90d1b16";
const sprint: Sprint = {
  id: sprintId,
  projectId,
  name: "Sprint 1",
  startDate: null,
  endDate: null,
  goal: null,
  status: "active",
  createdAt: new Date("2026-08-28T00:00:00.000Z"),
  updatedAt: new Date("2026-08-28T00:00:00.000Z"),
};
const view: TaskView = {
  id: viewId,
  sprintId,
  projectId,
  name: "Board",
  viewType: "board",
  viewContext: "sprint",
  config: { column_by: "status" },
  position: 0,
  createdAt: sprint.createdAt,
  updatedAt: sprint.updatedAt,
};

function bindings(): AppBindings {
  return { ENVIRONMENT: "test" } as AppBindings;
}

function iterations(overrides: Partial<IterationRuntime> = {}): IterationRuntime {
  return {
    listSprints: async () => [sprint],
    getSprint: async () => sprint,
    createSprint: async () => sprint,
    updateSprint: async () => sprint,
    deleteSprint: async () => undefined,
    completeSprint: async () => ({ ...sprint, status: "completed" }),
    listViews: async () => [view],
    getView: async () => view,
    createView: async () => view,
    updateView: async () => view,
    deleteView: async () => undefined,
    reorderViews: async () => undefined,
    listTaskPositions: async () => [],
    upsertTaskPositions: async () => undefined,
    ...overrides,
  };
}

function authorize() {
  return vi.fn(async () => ({
    authenticated: true as const,
    userId: "user-1",
    decision: {
      scopeExists: true,
      allowed: true,
      grants: [{ resource: "sprints" as const, action: "*" }],
    },
  }));
}

describe("iteration HTTP contract", () => {
  it("lists sprints behind sprints.read", async () => {
    const listSprints = vi.fn(iterations().listSprints);
    const authorizeProjectPermission = authorize();
    const app = createApp({
      authorizeProjectPermission,
      iterations: iterations({ listSprints }),
      log: vi.fn(),
    });
    const response = await app.request(`/api/v1/projects/${projectId}/sprints`, {}, bindings());
    expect(response.status).toBe(200);
    expect(authorizeProjectPermission).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      projectId,
      { sprints: ["read"] },
    );
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { items: [{ id: sprintId, status: "active" }] },
    });
  });

  it("completes a sprint with the trusted permission actor", async () => {
    const completeSprint = vi.fn(iterations().completeSprint);
    const app = createApp({
      authorizeProjectPermission: authorize(),
      iterations: iterations({ completeSprint }),
      log: vi.fn(),
    });
    const response = await app.request(
      `/api/v1/projects/${projectId}/sprints/${sprintId}/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ move_to_sprint_id: null }),
      },
      bindings(),
    );
    expect(response.status).toBe(200);
    expect(completeSprint).toHaveBeenCalledWith(
      expect.anything(),
      projectId,
      sprintId,
      null,
      "user-1",
    );
  });

  it("lists sprint views only with an explicit scoped sprint", async () => {
    const listViews = vi.fn(iterations().listViews);
    const app = createApp({
      authorizeProjectPermission: authorize(),
      iterations: iterations({ listViews }),
      log: vi.fn(),
    });
    const missing = await app.request(
      `/api/v1/projects/${projectId}/views?context=sprint`,
      {},
      bindings(),
    );
    expect(missing.status).toBe(400);

    const response = await app.request(
      `/api/v1/projects/${projectId}/views?context=sprint&sprint_id=${sprintId}`,
      {},
      bindings(),
    );
    expect(response.status).toBe(200);
    expect(listViews).toHaveBeenCalledWith(expect.anything(), projectId, "sprint", sprintId);
    await expect(response.json()).resolves.toMatchObject({
      data: { items: [{ id: viewId, view_type: "board" }] },
    });
  });
});
