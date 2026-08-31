import { describe, expect, it, vi } from "vitest";

import {
  type NormalizedTaskListInput,
  type PersistedTaskCreate,
  type PersistedTaskUpdate,
  type Task,
  type TaskRepository,
  TaskService,
  taskErrorCodes,
} from "../src/task/service";

const task: Task = {
  id: "c9d8cdf1-b208-4c87-b71f-cf4cdf2d373a",
  projectId: "6bdb7f3a-e59d-4826-8383-0104192157a8",
  taskNumber: 1,
  taskTypeId: null,
  statusId: null,
  sprintId: null,
  parentTaskId: null,
  title: "First task",
  description: null,
  importance: 0,
  storyPoints: null,
  assigneeIds: [],
  reporterId: null,
  customFields: {},
  startDate: null,
  dueDate: null,
  tags: [],
  viewPosition: null,
  viewGroupKey: null,
  createdAt: new Date("2026-08-28T00:00:00.000Z"),
  updatedAt: new Date("2026-08-28T00:00:00.000Z"),
};

function repository(overrides: Partial<TaskRepository> = {}): TaskRepository {
  return {
    listTypes: async () => [],
    listStatuses: async () => [],
    list: async (_projectId, input) => ({
      items: [],
      pageSize: input.pageSize,
      nextCursor: null,
      totalCount: 0,
      fieldSum: null,
    }),
    findById: async () => task,
    create: async () => task,
    update: async () => task,
    archive: async () => undefined,
    ...overrides,
  };
}

describe("task service", () => {
  it("normalizes task creation without inventing a non-default workflow id", async () => {
    const create = vi.fn(async (_input: PersistedTaskCreate) => task);
    const service = new TaskService(repository({ create }));

    await service.create(task.projectId, "user-1", {
      title: "  First task  ",
      tags: [" worker ", "worker", "postgres"],
      customFields: { source: "preview" },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: task.projectId,
        actor: { type: "user", id: "user-1" },
        title: "First task",
        statusId: undefined,
        taskTypeId: undefined,
        tags: ["worker", "postgres"],
        customFields: { source: "preview" },
      }),
    );
  });

  it("rejects invalid task content at the domain boundary", async () => {
    const service = new TaskService(repository());
    expect(() => service.create(task.projectId, "user-1", { title: " " })).toThrowError(
      expect.objectContaining({ code: taskErrorCodes.titleInvalid }),
    );
    expect(() =>
      service.create(task.projectId, "user-1", {
        title: "Task",
        description: { text: "bad" },
      }),
    ).toThrowError(expect.objectContaining({ code: taskErrorCodes.descriptionInvalid }));
    expect(() =>
      service.create(task.projectId, "user-1", { title: "Task", dueDate: "2026-99-99" }),
    ).toThrowError(expect.objectContaining({ code: taskErrorCodes.dateInvalid }));
  });

  it("normalizes list pagination and validates cursors", async () => {
    const list = vi.fn(async (_projectId: string, input: NormalizedTaskListInput) => ({
      items: [],
      pageSize: input.pageSize,
      nextCursor: null,
      totalCount: 0,
      fieldSum: null,
    }));
    const service = new TaskService(repository({ list }));

    await service.list(task.projectId, {
      pageSize: 500,
      cursor: "opaque-cursor",
      search: "  database  ",
      statusIds: ["status-1", "status-1"],
    });
    expect(list).toHaveBeenCalledWith(task.projectId, {
      pageSize: 100,
      cursor: "opaque-cursor",
      search: "database",
      statusIds: ["status-1"],
      sprintIds: [],
      assigneeIds: [],
      assigneeNull: false,
      taskTypeIds: [],
      taskTypeNull: false,
      parentTaskId: null,
      sprintId: undefined,
      sortBy: null,
      viewId: null,
      sumField: null,
      customFieldFilters: {},
      startDateAfter: null,
      startDateBefore: null,
      dueDateAfter: null,
      dueDateBefore: null,
      storyPointsMin: null,
      storyPointsMax: null,
      importanceRanges: [],
      tags: [],
    });
    expect(() => service.list(task.projectId, { cursor: "x".repeat(2_049) })).toThrowError(
      expect.objectContaining({ code: taskErrorCodes.cursorInvalid }),
    );
  });

  it("keeps explicit nulls in task updates and skips empty writes", async () => {
    const update = vi.fn(
      async (
        _projectId: string,
        _taskId: string,
        _actor: { type: "user" | "agent"; id: string },
        _input: PersistedTaskUpdate,
      ) => Promise.resolve(task),
    );
    const findById = vi.fn(async () => task);
    const service = new TaskService(repository({ update, findById }));

    await service.update(task.projectId, task.id, "user-1", {
      statusId: null,
      storyPoints: null,
    });
    expect(update).toHaveBeenCalledWith(
      task.projectId,
      task.id,
      { type: "user", id: "user-1" },
      {
        statusId: null,
        storyPoints: null,
      },
    );

    await service.update(task.projectId, task.id, "user-1", {});
    expect(findById).toHaveBeenCalledWith(task.projectId, task.id);
  });
});
