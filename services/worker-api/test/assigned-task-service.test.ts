import { describe, expect, it, vi } from "vitest";

import { type AssignedTaskRepository, AssignedTaskService } from "../src/task/assigned-service";
import type { Task } from "../src/task/service";

const task: Task = {
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
};

function repository(overrides: Partial<AssignedTaskRepository> = {}): AssignedTaskRepository {
  return {
    listCandidateProjectIds: async () => [task.projectId, "5963a2a4-d2fd-445b-bd6c-d29b3412eb08"],
    list: async () => ({
      items: [
        {
          task,
          cursor: {
            createdAt: "2026-09-01T00:00:00.000000Z",
            id: task.id,
            importance: 3,
          },
        },
      ],
      totalCount: 1,
      hasMore: false,
    }),
    ...overrides,
  };
}

describe("assigned task service", () => {
  it("filters projects through the shared tasks.read permission decision before querying tasks", async () => {
    const list = vi.fn(repository().list);
    const check = vi.fn(
      async (_userId: string, projectIds: string[]) =>
        new Map(
          projectIds.map((projectId) => [
            projectId,
            { allowed: projectId === task.projectId, scopeExists: true, grants: [] },
          ]),
        ),
    );
    const result = await new AssignedTaskService(repository({ list }), check).list("user-1", {
      pageSize: 10,
    });

    expect(check).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledWith("user-1", [task.projectId], {
      pageSize: 10,
      cursor: null,
    });
    expect(result).toMatchObject({ items: [task], pageSize: 10, totalCount: 1 });
  });

  it("does not query task bodies when no candidate project remains readable", async () => {
    const list = vi.fn(repository().list);
    const result = await new AssignedTaskService(
      repository({ list }),
      async (_userId, projectIds) =>
        new Map(
          projectIds.map((projectId) => [
            projectId,
            { allowed: false, scopeExists: true, grants: [] },
          ]),
        ),
    ).list("user-1", {});

    expect(list).not.toHaveBeenCalled();
    expect(result).toEqual({ items: [], pageSize: 10, nextCursor: null, totalCount: 0 });
  });

  it("issues a user-bound cursor only when another page exists", async () => {
    const result = await new AssignedTaskService(
      repository({
        list: async () => ({
          ...(await repository().list("user-1", [], { pageSize: 1, cursor: null })),
          hasMore: true,
        }),
      }),
      async (_userId, projectIds) =>
        new Map(
          projectIds.map((projectId) => [
            projectId,
            { allowed: true, scopeExists: true, grants: [] },
          ]),
        ),
    ).list("user-1", { pageSize: 1 });

    expect(result.nextCursor).toEqual(expect.any(String));
    const list = vi.fn(repository().list);
    await expect(
      new AssignedTaskService(repository({ list }), async () => new Map()).list("user-2", {
        cursor: result.nextCursor ?? undefined,
      }),
    ).rejects.toMatchObject({ code: "TASK_CURSOR_INVALID" });
    expect(list).not.toHaveBeenCalled();
  });
});
