import { Buffer } from "node:buffer";

import * as z from "zod";

export const notificationErrorCodes = {
  cursorInvalid: "NOTIFICATION_INVALID_CURSOR",
  notFound: "NOTIFICATION_NOT_FOUND",
  pageSizeInvalid: "NOTIFICATION_PAGE_SIZE_INVALID",
} as const;

export type NotificationErrorCode =
  (typeof notificationErrorCodes)[keyof typeof notificationErrorCodes];

export class NotificationError extends Error {
  constructor(
    readonly code: NotificationErrorCode,
    message = code,
  ) {
    super(message);
    this.name = "NotificationError";
  }
}

export type NotificationType = "assigned" | "mentioned";

export type Notification = {
  id: string;
  type: NotificationType;
  actorFullName: string;
  actorUsername: string;
  actorAvatarUrl: string | null;
  actorMemberType: "human" | "agent";
  actorAgentType: string;
  actorAgentLlmProvider: string;
  actorAgentAcpProvider: string | null;
  taskId: string;
  taskTitle: string;
  taskNumber: number;
  projectId: string;
  projectName: string;
  readAt: Date | null;
  createdAt: Date;
  cursorCreatedAt: string;
};

export type NotificationCursor = {
  createdAt: string;
  id: string;
};

export type NotificationPage = {
  items: Notification[];
  pageSize: number;
  nextCursor: string | null;
  unreadCount: number;
};

export interface NotificationRepository {
  list(
    userId: string,
    input: { pageSize: number; cursor: NotificationCursor | null },
  ): Promise<{ items: Notification[]; hasMore: boolean }>;
  unreadCount(userId: string): Promise<number>;
  markAsRead(userId: string, notificationId: string, now: Date): Promise<boolean>;
  markAllAsRead(userId: string, now: Date): Promise<void>;
}

const cursorSchema = z
  .object({
    v: z.literal(1),
    userId: z.string().min(1).max(255),
    createdAt: z.iso.datetime({ offset: true }),
    id: z.uuid(),
  })
  .strict();

function encodeCursor(userId: string, notification: Notification): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      userId,
      createdAt: notification.cursorCreatedAt,
      id: notification.id,
    }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(userId: string, value: string | undefined): NotificationCursor | null {
  if (!value) return null;
  try {
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (parsed.userId !== userId) throw new Error("cursor owner mismatch");
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new NotificationError(notificationErrorCodes.cursorInvalid);
  }
}

export class NotificationService {
  constructor(
    private readonly repository: NotificationRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(
    userId: string,
    input: { pageSize?: number; cursor?: string },
  ): Promise<NotificationPage> {
    const pageSize = input.pageSize ?? 20;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
      throw new NotificationError(notificationErrorCodes.pageSizeInvalid);
    }
    const cursor = decodeCursor(userId, input.cursor);
    const [{ items, hasMore }, unreadCount] = await Promise.all([
      this.repository.list(userId, { pageSize, cursor }),
      this.repository.unreadCount(userId),
    ]);
    const last = items.at(-1);
    return {
      items,
      pageSize,
      nextCursor: hasMore && last ? encodeCursor(userId, last) : null,
      unreadCount,
    };
  }

  async markAsRead(userId: string, notificationId: string): Promise<void> {
    const found = await this.repository.markAsRead(userId, notificationId, this.now());
    if (!found) throw new NotificationError(notificationErrorCodes.notFound);
  }

  markAllAsRead(userId: string): Promise<void> {
    return this.repository.markAllAsRead(userId, this.now());
  }
}
