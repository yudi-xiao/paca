import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import type { AppBindings } from "../src/bindings";
import type { TaskLinkRuntime } from "../src/task/link-runtime";
import { type TaskLink, TaskLinkError, taskLinkErrorCodes } from "../src/task/link-service";

const projectId = "6bdb7f3a-e59d-4826-8383-0104192157a8";
const taskId = "c9d8cdf1-b208-4c87-b71f-cf4cdf2d373a";
const targetTaskId = "6d157b8f-e3c0-4957-8560-f471edcd676b";
const linkId = "52b19bd5-e9c0-4800-8ae1-68dac6617ec6";

const link: TaskLink = {
  id: linkId,
  projectId,
  sourceTaskId: taskId,
  targetTaskId,
  linkType: "blocks",
  displayLinkType: "blocks",
  linkedTask: {
    id: targetTaskId,
    taskNumber: 2,
    title: "Target task",
    statusId: null,
    taskTypeId: null,
  },
  createdBy: "user-1",
  createdAt: new Date("2026-08-31T00:00:00.000Z"),
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
      grants: [{ resource: "tasks" as const, action: "*" }],
    },
  }));
}

function taskLinks(overrides: Partial<TaskLinkRuntime> = {}): TaskLinkRuntime {
  return {
    list: async () => [link],
    create: async () => link,
    delete: async () => undefined,
    ...overrides,
  };
}

describe("task link HTTP contract", () => {
  it("lists links with inverse-ready response fields behind tasks.read", async () => {
    const list = vi.fn(taskLinks().list);
    const authorizeProjectPermission = authorize();
    const app = createApp({
      authorizeProjectPermission,
      taskLinks: taskLinks({ list }),
      log: vi.fn(),
    });

    const response = await app.request(
      `/api/v1/projects/${projectId}/tasks/${taskId}/links`,
      {},
      bindings(),
    );

    expect(response.status).toBe(200);
    expect(authorizeProjectPermission).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      projectId,
      { tasks: ["read"] },
    );
    expect(list).toHaveBeenCalledWith(expect.anything(), projectId, taskId);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        items: [
          {
            id: linkId,
            source_task_id: taskId,
            target_task_id: targetTaskId,
            link_type: "blocks",
            display_link_type: "blocks",
            linked_task: { id: targetTaskId, task_number: 2, title: "Target task" },
            created_by: "user-1",
          },
        ],
      },
    });
  });

  it("creates links with the authenticated permission actor behind tasks.write", async () => {
    const create = vi.fn(taskLinks().create);
    const authorizeProjectPermission = authorize();
    const app = createApp({
      authorizeProjectPermission,
      taskLinks: taskLinks({ create }),
      log: vi.fn(),
    });

    const response = await app.request(
      `/api/v1/projects/${projectId}/tasks/${taskId}/links`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target_task_id: targetTaskId, link_type: "blocks" }),
      },
      bindings(),
    );

    expect(response.status).toBe(201);
    expect(authorizeProjectPermission).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      projectId,
      { tasks: ["write"] },
    );
    expect(create).toHaveBeenCalledWith(expect.anything(), projectId, taskId, "user-1", {
      targetTaskId,
      linkType: "blocks",
    });
  });

  it("deletes only a validated link through the scoped route", async () => {
    const remove = vi.fn(taskLinks().delete);
    const app = createApp({
      authorizeProjectPermission: authorize(),
      taskLinks: taskLinks({ delete: remove }),
      log: vi.fn(),
    });

    const response = await app.request(
      `/api/v1/projects/${projectId}/tasks/${taskId}/links/${linkId}`,
      { method: "DELETE" },
      bindings(),
    );

    expect(response.status).toBe(204);
    expect(remove).toHaveBeenCalledWith(expect.anything(), projectId, taskId, linkId, "user-1");
  });

  it("maps duplicate links to the legacy conflict code", async () => {
    const app = createApp({
      authorizeProjectPermission: authorize(),
      taskLinks: taskLinks({
        create: async () => {
          throw new TaskLinkError(taskLinkErrorCodes.duplicate);
        },
      }),
      log: vi.fn(),
    });

    const response = await app.request(
      `/api/v1/projects/${projectId}/tasks/${taskId}/links`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target_task_id: targetTaskId, link_type: "blocks" }),
      },
      bindings(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error_code: taskLinkErrorCodes.duplicate,
    });
  });

  it("rejects malformed ids and link types before calling the runtime", async () => {
    const create = vi.fn(taskLinks().create);
    const app = createApp({
      authorizeProjectPermission: authorize(),
      taskLinks: taskLinks({ create }),
      log: vi.fn(),
    });

    const response = await app.request(
      `/api/v1/projects/${projectId}/tasks/${taskId}/links`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target_task_id: targetTaskId, link_type: "unknown" }),
      },
      bindings(),
    );

    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
});
