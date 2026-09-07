import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import type { AppBindings } from "../src/bindings";
import type { AssignedTaskRuntime } from "../src/task/assigned-runtime";
import type { Task } from "../src/task/service";

const task = {
  id: "c9d8cdf1-b208-4c87-b71f-cf4cdf2d373a",
  projectId: "6bdb7f3a-e59d-4826-8383-0104192157a8",
  taskNumber: 7,
  taskTypeId: null,
  statusId: null,
  sprintId: null,
  parentTaskId: null,
  title: "Assigned task",
  description: null,
  importance: 3,
  storyPoints: null,
  assigneeIds: [],
  reporterId: null,
  customFields: {},
  startDate: null,
  dueDate: null,
  tags: [],
  viewPosition: null,
  viewGroupKey: null,
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
} satisfies Task;

const session = {
  id: "session-1",
  user: {
    id: "user-1",
    name: "Tester",
    email: "tester@example.com",
    emailVerified: true,
    image: null,
    createdAt: "2026-09-01T00:00:00.000Z",
  },
  expiresAt: "2026-09-08T00:00:00.000Z",
};

describe("assigned task HTTP contract", () => {
  it("uses only the authenticated user identity and preserves the React envelope", async () => {
    const list = vi.fn<AssignedTaskRuntime["list"]>(async () => ({
      items: [task],
      pageSize: 5,
      nextCursor: "next",
      totalCount: 2,
    }));
    const app = createApp({
      currentUserSession: async () => session,
      assignedTasks: { list },
      log: vi.fn(),
    });
    const response = await app.request("/api/v1/users/me/tasks?page_size=5&user_id=attacker", {}, {
      ENVIRONMENT: "test",
    } as AppBindings);

    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith(expect.anything(), "user-1", {
      pageSize: 5,
      cursor: undefined,
    });
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        items: [{ id: task.id, project_id: task.projectId, task_number: 7 }],
        page_size: 5,
        next_cursor: "next",
        total_count: 2,
      },
    });
  });

  it("rejects invalid pagination before calling the runtime", async () => {
    const list = vi.fn<AssignedTaskRuntime["list"]>();
    const app = createApp({
      currentUserSession: async () => session,
      assignedTasks: { list },
      log: vi.fn(),
    });
    const response = await app.request("/api/v1/users/me/tasks?page_size=101", {}, {
      ENVIRONMENT: "test",
    } as AppBindings);

    expect(response.status).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });
});
