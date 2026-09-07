import { describe, expect, it, vi } from "vitest";

import { extractMentionedUserIds } from "../src/notification/postgres-write";
import {
  type Notification,
  NotificationError,
  type NotificationRepository,
  NotificationService,
  notificationErrorCodes,
} from "../src/notification/service";

const userId = "user-1";

function notification(id: string, createdAt: string): Notification {
  return {
    id,
    type: "assigned",
    actorFullName: "Task Author",
    actorUsername: "author",
    actorAvatarUrl: null,
    actorMemberType: "human",
    actorAgentType: "",
    actorAgentLlmProvider: "",
    actorAgentAcpProvider: null,
    taskId: "c9d8cdf1-b208-4c87-b71f-cf4cdf2d373a",
    taskTitle: "Ship notifications",
    taskNumber: 8,
    projectId: "6bdb7f3a-e59d-4826-8383-0104192157a8",
    projectName: "Cloudflare migration",
    readAt: null,
    createdAt: new Date(createdAt),
    cursorCreatedAt: createdAt,
  };
}

function repository(overrides: Partial<NotificationRepository> = {}): NotificationRepository {
  return {
    list: async () => ({ items: [], hasMore: false }),
    unreadCount: async () => 0,
    markAsRead: async () => true,
    markAllAsRead: async () => undefined,
    ...overrides,
  };
}

describe("notification service", () => {
  it("creates an owner-bound keyset cursor and restores it for the next page", async () => {
    const item = notification("724122b6-973b-436f-a507-889b1d599495", "2026-09-07T08:00:00.000Z");
    const list = vi
      .fn<NotificationRepository["list"]>()
      .mockResolvedValueOnce({ items: [item], hasMore: true })
      .mockResolvedValueOnce({ items: [], hasMore: false });
    const service = new NotificationService(repository({ list, unreadCount: async () => 3 }));

    const first = await service.list(userId, { pageSize: 1 });
    expect(first).toMatchObject({ items: [item], pageSize: 1, unreadCount: 3 });
    expect(first.nextCursor).toEqual(expect.any(String));

    await service.list(userId, { pageSize: 1, cursor: first.nextCursor ?? undefined });
    expect(list).toHaveBeenNthCalledWith(2, userId, {
      pageSize: 1,
      cursor: { createdAt: item.cursorCreatedAt, id: item.id },
    });

    await expect(
      service.list("different-user", { pageSize: 1, cursor: first.nextCursor ?? undefined }),
    ).rejects.toMatchObject({ code: notificationErrorCodes.cursorInvalid });
  });

  it("rejects invalid pagination and maps an invisible notification to not found", async () => {
    const service = new NotificationService(repository({ markAsRead: async () => false }));
    await expect(service.list(userId, { pageSize: 0 })).rejects.toMatchObject({
      code: notificationErrorCodes.pageSizeInvalid,
    });
    await expect(service.list(userId, { cursor: "not-a-cursor" })).rejects.toMatchObject({
      code: notificationErrorCodes.cursorInvalid,
    });
    await expect(
      service.markAsRead(userId, "724122b6-973b-436f-a507-889b1d599495"),
    ).rejects.toEqual(new NotificationError(notificationErrorCodes.notFound));
  });

  it("uses one trusted timestamp for single and bulk read operations", async () => {
    const now = new Date("2026-09-07T08:30:00.000Z");
    const markAsRead = vi.fn(async () => true);
    const markAllAsRead = vi.fn(async () => undefined);
    const service = new NotificationService(repository({ markAsRead, markAllAsRead }), () => now);

    await service.markAsRead(userId, "724122b6-973b-436f-a507-889b1d599495");
    await service.markAllAsRead(userId);

    expect(markAsRead).toHaveBeenCalledWith(userId, "724122b6-973b-436f-a507-889b1d599495", now);
    expect(markAllAsRead).toHaveBeenCalledWith(userId, now);
  });

  it("extracts only unique structured team mentions from BlockNote content", () => {
    expect(
      extractMentionedUserIds([
        {
          type: "paragraph",
          content: [
            { type: "teamMention", props: { id: "user-2", name: "Ada" } },
            { type: "text", text: "hello" },
            { type: "teamMention", props: { id: "user-2", name: "Ada" } },
            { type: "taskReference", props: { id: "task-1" } },
          ],
        },
        null,
      ]),
    ).toEqual(["user-2"]);
  });
});
