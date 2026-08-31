import { describe, expect, it, vi } from "vitest";

import {
  type TaskActivity,
  type TaskActivityRepository,
  TaskActivityService,
  taskActivityErrorCodes,
} from "../src/task/activity-service";

const projectId = "6bdb7f3a-e59d-4826-8383-0104192157a8";
const taskId = "c9d8cdf1-b208-4c87-b71f-cf4cdf2d373a";

const activity: TaskActivity = {
  id: "34b328ac-52f6-4bf1-a4a6-bc355d3b8200",
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

function repository(overrides: Partial<TaskActivityRepository> = {}): TaskActivityRepository {
  return {
    list: async () => [activity],
    createComment: async () => activity,
    updateComment: async () => activity,
    deleteComment: async () => undefined,
    ...overrides,
  };
}

describe("task activity service", () => {
  it("clones validated BlockNote comment content before persistence", async () => {
    const createComment = vi.fn(
      async (_projectId: string, _taskId: string, _actorUserId: string, _content: unknown[]) =>
        activity,
    );
    const service = new TaskActivityService(repository({ createComment }));
    const content = [{ type: "paragraph", content: [{ type: "text", text: "Ready" }] }];

    await service.createComment(projectId, taskId, "user-1", content);
    expect(createComment).toHaveBeenCalledWith(projectId, taskId, "user-1", content);
    expect(createComment.mock.calls[0]?.[3]).not.toBe(content);
  });

  it("rejects empty, non-array and oversized comments at the domain boundary", () => {
    const service = new TaskActivityService(repository());
    expect(() => service.createComment(projectId, taskId, "user-1", [])).toThrowError(
      expect.objectContaining({ code: taskActivityErrorCodes.commentInvalid }),
    );
    expect(() => service.createComment(projectId, taskId, "user-1", { text: "bad" })).toThrowError(
      expect.objectContaining({ code: taskActivityErrorCodes.commentInvalid }),
    );
    expect(() =>
      service.createComment(projectId, taskId, "user-1", ["x".repeat(64_001)]),
    ).toThrowError(expect.objectContaining({ code: taskActivityErrorCodes.commentInvalid }));
  });

  it("passes the authenticated actor through comment update and delete", async () => {
    const updateComment = vi.fn(async () => activity);
    const deleteComment = vi.fn(async () => undefined);
    const service = new TaskActivityService(repository({ updateComment, deleteComment }));
    const content = [{ type: "paragraph", content: [{ type: "text", text: "Updated" }] }];

    await service.updateComment(projectId, taskId, activity.id, "user-1", content);
    await service.deleteComment(projectId, taskId, activity.id, "user-1");
    expect(updateComment).toHaveBeenCalledWith(projectId, taskId, activity.id, "user-1", content);
    expect(deleteComment).toHaveBeenCalledWith(projectId, taskId, activity.id, "user-1");
  });
});
