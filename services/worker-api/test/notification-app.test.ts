import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import type { AppBindings } from "../src/bindings";
import type { NotificationRuntime } from "../src/notification/runtime";
import {
  type Notification,
  NotificationError,
  notificationErrorCodes,
} from "../src/notification/service";

const notificationId = "724122b6-973b-436f-a507-889b1d599495";

const item: Notification = {
  id: notificationId,
  type: "mentioned",
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
  createdAt: new Date("2026-09-07T08:00:00.000Z"),
  cursorCreatedAt: "2026-09-07T08:00:00.000000Z",
};

function bindings(): AppBindings {
  return { ENVIRONMENT: "test" } as AppBindings;
}

function currentUserSession() {
  return Promise.resolve({
    id: "session-1",
    user: {
      id: "user-1",
      name: "Internal Tester",
      email: "internal@example.com",
      emailVerified: true,
      image: null,
      createdAt: "2026-08-27T00:00:00.000Z",
    },
    expiresAt: "2026-09-14T00:00:00.000Z",
  });
}

function notifications(overrides: Partial<NotificationRuntime> = {}): NotificationRuntime {
  return {
    list: async () => ({
      items: [item],
      pageSize: 20,
      nextCursor: null,
      unreadCount: 1,
    }),
    markAsRead: async () => undefined,
    markAllAsRead: async () => undefined,
    ...overrides,
  };
}

describe("notification HTTP contract", () => {
  it("lists the current user's real notification projection without caching", async () => {
    const list = vi.fn(notifications().list);
    const app = createApp({
      currentUserSession,
      notifications: notifications({ list }),
      log: vi.fn(),
    });
    const response = await app.request(
      "/api/v1/users/me/notifications?page_size=20",
      {},
      bindings(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(list).toHaveBeenCalledWith(expect.anything(), "user-1", {
      pageSize: 20,
      cursor: undefined,
    });
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        items: [
          {
            id: notificationId,
            type: "mentioned",
            actor_full_name: "Task Author",
            task_number: 8,
            read_at: null,
          },
        ],
        unread_count: 1,
      },
    });
  });

  it("requires a Better Auth session before opening the repository", async () => {
    const list = vi.fn(notifications().list);
    const app = createApp({
      currentUserSession: async () => null,
      notifications: notifications({ list }),
      log: vi.fn(),
    });
    const response = await app.request("/api/v1/users/me/notifications", {}, bindings());

    expect(response.status).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });

  it("marks only the current user's notification and supports read-all", async () => {
    const markAsRead = vi.fn(async () => undefined);
    const markAllAsRead = vi.fn(async () => undefined);
    const app = createApp({
      currentUserSession,
      notifications: notifications({ markAsRead, markAllAsRead }),
      log: vi.fn(),
    });

    const one = await app.request(
      `/api/v1/users/me/notifications/${notificationId}/read`,
      { method: "PATCH" },
      bindings(),
    );
    const all = await app.request(
      "/api/v1/users/me/notifications/read-all",
      { method: "POST" },
      bindings(),
    );

    expect(one.status).toBe(204);
    expect(all.status).toBe(204);
    expect(markAsRead).toHaveBeenCalledWith(expect.anything(), "user-1", notificationId);
    expect(markAllAsRead).toHaveBeenCalledWith(expect.anything(), "user-1");
  });

  it("fails closed for malformed, cross-user, and invalid cursor requests", async () => {
    const runtime = notifications({
      list: async () => {
        throw new NotificationError(notificationErrorCodes.cursorInvalid);
      },
      markAsRead: async () => {
        throw new NotificationError(notificationErrorCodes.notFound);
      },
    });
    const app = createApp({ currentUserSession, notifications: runtime, log: vi.fn() });

    const invalidId = await app.request(
      "/api/v1/users/me/notifications/not-a-uuid/read",
      { method: "PATCH" },
      bindings(),
    );
    const hidden = await app.request(
      `/api/v1/users/me/notifications/${notificationId}/read`,
      { method: "PATCH" },
      bindings(),
    );
    const cursor = await app.request(
      "/api/v1/users/me/notifications?cursor=foreign",
      {},
      bindings(),
    );

    expect(invalidId.status).toBe(400);
    expect(hidden.status).toBe(404);
    expect(cursor.status).toBe(400);
  });
});
