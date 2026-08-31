import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import type { AppBindings } from "../src/bindings";
import type { TaskRuntime } from "../src/task/runtime";
import type { Task } from "../src/task/service";

const projectId = "6bdb7f3a-e59d-4826-8383-0104192157a8";
const taskId = "c9d8cdf1-b208-4c87-b71f-cf4cdf2d373a";

const task: Task = {
  id: taskId,
  projectId,
  taskNumber: 7,
  taskTypeId: "8fa2bf99-0184-4633-9023-cdf9e6c22ebd",
  statusId: "8f462eda-2adb-443f-b6b3-c62c78eeb00d",
  sprintId: null,
  parentTaskId: null,
  title: "Migrate task API",
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

function bindings(): AppBindings {
  return { ENVIRONMENT: "test" } as AppBindings;
}

function tasks(overrides: Partial<TaskRuntime> = {}): TaskRuntime {
  return {
    listTypes: async () => [],
    listStatuses: async () => [],
    list: async (_env, _projectId, input) => ({
      items: [task],
      pageSize: input.pageSize ?? 20,
      nextCursor: null,
      totalCount: 1,
      fieldSum: null,
    }),
    get: async () => task,
    create: async () => task,
    update: async () => task,
    archive: async () => undefined,
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

describe("task HTTP contract", () => {
  it("lists tasks behind tasks.read and preserves the React envelope", async () => {
    const list = vi.fn(tasks().list);
    const authorizeProjectPermission = authorize();
    const app = createApp({
      authorizeProjectPermission,
      tasks: tasks({ list }),
      log: vi.fn(),
    });
    const response = await app.request(
      `/api/v1/projects/${projectId}/tasks?page_size=25&search=migrate`,
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
    expect(list).toHaveBeenCalledWith(expect.anything(), projectId, {
      pageSize: 25,
      cursor: undefined,
      search: "migrate",
      statusIds: [],
      sprintIds: [],
      assigneeIds: [],
      assigneeNull: false,
      taskTypeIds: [],
      taskTypeNull: false,
      parentTaskId: undefined,
      sprintId: undefined,
      sortBy: undefined,
      viewId: undefined,
      sumField: undefined,
      customFieldFilters: {},
      startDateAfter: undefined,
      startDateBefore: undefined,
      dueDateAfter: undefined,
      dueDateBefore: undefined,
      storyPointsMin: undefined,
      storyPointsMax: undefined,
      importanceRanges: [],
      tags: [],
    });
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        items: [{ id: taskId, task_number: 7, title: "Migrate task API", sprint_id: null }],
        page_size: 25,
        total_count: 1,
      },
    });
  });

  it("passes the complete interaction view query contract to the task domain", async () => {
    const list = vi.fn(async (_env, _projectId, input) => ({
      items: [{ ...task, viewPosition: 12.5, viewGroupKey: "status-a" }],
      pageSize: input.pageSize ?? 20,
      nextCursor: "next",
      totalCount: 4,
      fieldSum: 13,
    }));
    const app = createApp({
      authorizeProjectPermission: authorize(),
      tasks: tasks({ list }),
      log: vi.fn(),
    });
    const sprintId = "aa7042be-4f30-4e93-a6c6-70b6dfe7f0a8";
    const statusId = "8f462eda-2adb-443f-b6b3-c62c78eeb00d";
    const assigneeId = "f08656b7-ea66-4cc2-9019-3466bd4cf214";
    const typeId = "8fa2bf99-0184-4633-9023-cdf9e6c22ebd";
    const viewId = "5ec5d18a-f7ea-4b76-8294-8b756f7099e4";
    const params = new URLSearchParams({
      page_size: "40",
      cursor: "opaque",
      sprint_ids: sprintId,
      status_ids: statusId,
      assignee_id: "null",
      assignee_ids: assigneeId,
      task_type_ids: typeId,
      sort_by: "importance",
      view_id: viewId,
      sum_field: "story_points",
      custom_field_filters: JSON.stringify({ estimate: { min: 2, max: 8 } }),
      start_date_after: "2026-08-01",
      due_date_before: "2026-08-31",
      story_points_min: "1",
      story_points_max: "13",
      importance_ranges: JSON.stringify([{ min: 1, max: 100 }]),
      tags: "worker,cloudflare",
    });
    const response = await app.request(
      `/api/v1/projects/${projectId}/tasks?${params.toString()}`,
      {},
      bindings(),
    );

    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith(
      expect.anything(),
      projectId,
      expect.objectContaining({
        pageSize: 40,
        cursor: "opaque",
        sprintIds: [sprintId],
        statusIds: [statusId],
        assigneeIds: [assigneeId],
        assigneeNull: true,
        taskTypeIds: [typeId],
        sortBy: "importance",
        viewId,
        sumField: "story_points",
        customFieldFilters: { estimate: { min: 2, max: 8 } },
        startDateAfter: "2026-08-01",
        dueDateBefore: "2026-08-31",
        storyPointsMin: 1,
        storyPointsMax: 13,
        importanceRanges: [{ min: 1, max: 100 }],
        tags: ["worker", "cloudflare"],
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      data: {
        field_sum: 13,
        next_cursor: "next",
        items: [{ view_position: 12.5, view_group_key: "status-a" }],
      },
    });
  });

  it("rejects malformed dynamic task filters before reaching the repository", async () => {
    const list = vi.fn(tasks().list);
    const app = createApp({
      authorizeProjectPermission: authorize(),
      tasks: tasks({ list }),
      log: vi.fn(),
    });
    const response = await app.request(
      `/api/v1/projects/${projectId}/tasks?custom_field_filters=%7Bbad`,
      {},
      bindings(),
    );

    expect(response.status).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });

  it("creates a task with the authenticated permission actor", async () => {
    const create = vi.fn(tasks().create);
    const app = createApp({
      authorizeProjectPermission: authorize(),
      tasks: tasks({ create }),
      log: vi.fn(),
    });
    const response = await app.request(
      `/api/v1/projects/${projectId}/tasks`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Migrate task API" }),
      },
      bindings(),
    );

    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith(expect.anything(), projectId, "user-1", {
      title: "Migrate task API",
      statusId: undefined,
      taskTypeId: undefined,
      parentTaskId: undefined,
      description: undefined,
      importance: undefined,
      storyPoints: undefined,
      assigneeIds: undefined,
      customFields: undefined,
      startDate: undefined,
      dueDate: undefined,
      tags: undefined,
    });
  });

  it("passes a validated sprint assignment through to the task domain", async () => {
    const create = vi.fn(tasks().create);
    const app = createApp({
      authorizeProjectPermission: authorize(),
      tasks: tasks({ create }),
      log: vi.fn(),
    });
    const response = await app.request(
      `/api/v1/projects/${projectId}/tasks`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Sprint task",
          sprint_id: "aa7042be-4f30-4e93-a6c6-70b6dfe7f0a8",
        }),
      },
      bindings(),
    );

    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith(
      expect.anything(),
      projectId,
      "user-1",
      expect.objectContaining({
        sprintId: "aa7042be-4f30-4e93-a6c6-70b6dfe7f0a8",
      }),
    );
  });
});
