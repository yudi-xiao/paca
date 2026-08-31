import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import type { AppBindings } from "../src/bindings";
import type { TaskActivityRuntime } from "../src/task/activity-runtime";
import {
  type TaskActivity,
  TaskActivityError,
  taskActivityErrorCodes,
} from "../src/task/activity-service";

const projectId = "6bdb7f3a-e59d-4826-8383-0104192157a8";
const taskId = "c9d8cdf1-b208-4c87-b71f-cf4cdf2d373a";
const commentId = "34b328ac-52f6-4bf1-a4a6-bc355d3b8200";

const activity: TaskActivity = {
  id: commentId,
  taskId,
  projectId,
  actorType: "user",
  actorId: "user-1",
  actorUserId: "user-1",
  actorAgentId: null,
  actorMemberId: "a1e1de51-3193-44a1-af35-029f9e53ed19",
  actorName: "Preview User",
  actorUsername: "preview@example.com",
  actorAvatarUrl: null,
  activityType: "comment",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Ready" }] }],
  createdAt: new Date("2026-08-28T00:00:00.000Z"),
  updatedAt: new Date("2026-08-28T00:00:00.000Z"),
};

function bindings(): AppBindings {
  return { ENVIRONMENT: "test" } as AppBindings;
}

function runtime(overrides: Partial<TaskActivityRuntime> = {}): TaskActivityRuntime {
  return {
    list: async () => [activity],
    createComment: async () => activity,
    updateComment: async () => activity,
    deleteComment: async () => undefined,
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
      grants: [{ resource: "tasks" as const, action: "*" }],
    },
  }));
}

describe("task activity HTTP contract", () => {
  it("lists activity behind tasks.read using the legacy React envelope", async () => {
    const list = vi.fn(runtime().list);
    const authorizeProjectPermission = authorize();
    const app = createApp({
      authorizeProjectPermission,
      taskActivities: runtime({ list }),
      log: vi.fn(),
    });

    const response = await app.request(
      `/api/v1/projects/${projectId}/tasks/${taskId}/activities`,
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
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        items: [
          {
            id: commentId,
            task_id: taskId,
            actor_type: "user",
            actor_id: "user-1",
            actor_user_id: "user-1",
            actor_agent_id: null,
            activity_type: "comment",
          },
        ],
      },
    });
  });

  it("creates comments with the authenticated permission actor behind tasks.write", async () => {
    const createComment = vi.fn(runtime().createComment);
    const authorizeProjectPermission = authorize();
    const app = createApp({
      authorizeProjectPermission,
      taskActivities: runtime({ createComment }),
      log: vi.fn(),
    });
    const content = [{ type: "paragraph", content: [{ type: "text", text: "Ready" }] }];

    const response = await app.request(
      `/api/v1/projects/${projectId}/tasks/${taskId}/activities/comments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
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
    expect(createComment).toHaveBeenCalledWith(
      expect.anything(),
      projectId,
      taskId,
      "user-1",
      content,
    );
  });

  it("maps comment ownership failures to 403", async () => {
    const updateComment = vi.fn(async () => {
      throw new TaskActivityError(taskActivityErrorCodes.commentForbidden);
    });
    const app = createApp({
      authorizeProjectPermission: authorize(),
      taskActivities: runtime({ updateComment }),
      log: vi.fn(),
    });

    const response = await app.request(
      `/api/v1/projects/${projectId}/tasks/${taskId}/activities/comments/${commentId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: [{ type: "paragraph", content: ["no"] }] }),
      },
      bindings(),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error_code: taskActivityErrorCodes.commentForbidden,
    });
  });

  it("rejects malformed IDs and empty comments before calling the runtime", async () => {
    const createComment = vi.fn(runtime().createComment);
    const app = createApp({
      authorizeProjectPermission: authorize(),
      taskActivities: runtime({ createComment }),
      log: vi.fn(),
    });
    const response = await app.request(
      `/api/v1/projects/${projectId}/tasks/not-a-uuid/activities/comments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: [] }),
      },
      bindings(),
    );
    expect(response.status).toBe(400);
    expect(createComment).not.toHaveBeenCalled();
  });
});
