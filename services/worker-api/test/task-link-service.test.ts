import { describe, expect, it, vi } from "vitest";

import {
  type TaskLink,
  type TaskLinkRepository,
  TaskLinkService,
  taskLinkErrorCodes,
} from "../src/task/link-service";

const projectId = "6bdb7f3a-e59d-4826-8383-0104192157a8";
const sourceTaskId = "c9d8cdf1-b208-4c87-b71f-cf4cdf2d373a";
const targetTaskId = "6d157b8f-e3c0-4957-8560-f471edcd676b";

const link: TaskLink = {
  id: "52b19bd5-e9c0-4800-8ae1-68dac6617ec6",
  projectId,
  sourceTaskId,
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

function repository(overrides: Partial<TaskLinkRepository> = {}): TaskLinkRepository {
  return {
    list: async () => [link],
    create: async () => link,
    delete: async () => undefined,
    ...overrides,
  };
}

describe("task link service", () => {
  it("delegates valid directional links with the trusted actor", async () => {
    const create = vi.fn(async () => link);
    const service = new TaskLinkService(repository({ create }));

    await service.create({
      projectId,
      sourceTaskId,
      targetTaskId,
      linkType: "blocks",
      actorUserId: "user-1",
    });

    expect(create).toHaveBeenCalledWith({
      projectId,
      sourceTaskId,
      targetTaskId,
      linkType: "blocks",
      actorUserId: "user-1",
    });
  });

  it("rejects self links before persistence", () => {
    const create = vi.fn(async () => link);
    const service = new TaskLinkService(repository({ create }));

    expect(() =>
      service.create({
        projectId,
        sourceTaskId,
        targetTaskId: sourceTaskId,
        linkType: "relates_to",
        actorUserId: "user-1",
      }),
    ).toThrowError(expect.objectContaining({ code: taskLinkErrorCodes.self }));
    expect(create).not.toHaveBeenCalled();
  });
});
