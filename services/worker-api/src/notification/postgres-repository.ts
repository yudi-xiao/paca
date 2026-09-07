import { and, count, desc, eq, isNull, or, sql } from "drizzle-orm";

import type { PacaDatabase } from "../database";
import {
  agent,
  pacaNotifications,
  pacaProjectMembers,
  pacaProjects,
  pacaTasks,
  user,
} from "../db/schema";
import type {
  Notification,
  NotificationCursor,
  NotificationRepository,
  NotificationType,
} from "./service";

type NotificationReadRow = {
  id: string;
  type: string;
  actorType: string;
  actorUserName: string | null;
  actorUserEmail: string | null;
  actorUserImage: string | null;
  actorAgentName: string | null;
  taskId: string;
  taskTitle: string;
  taskNumber: number;
  projectId: string;
  projectName: string;
  readAt: Date | null;
  createdAt: Date;
  cursorCreatedAt: string;
};

function fromRow(row: NotificationReadRow): Notification {
  const isAgent = row.actorType === "agent";
  const actorFullName = isAgent
    ? (row.actorAgentName ?? "Agent")
    : (row.actorUserName ?? "Former member");
  return {
    id: row.id,
    type: row.type as NotificationType,
    actorFullName,
    actorUsername: isAgent
      ? (row.actorAgentName ?? "agent")
      : (row.actorUserEmail?.split("@")[0] ?? actorFullName),
    actorAvatarUrl: isAgent ? null : row.actorUserImage,
    actorMemberType: isAgent ? "agent" : "human",
    actorAgentType: "",
    actorAgentLlmProvider: "",
    actorAgentAcpProvider: null,
    taskId: row.taskId,
    taskTitle: row.taskTitle,
    taskNumber: row.taskNumber,
    projectId: row.projectId,
    projectName: row.projectName,
    readAt: row.readAt,
    createdAt: row.createdAt,
    cursorCreatedAt: row.cursorCreatedAt,
  };
}

export class PostgresNotificationRepository implements NotificationRepository {
  constructor(private readonly database: PacaDatabase) {}

  async list(
    userId: string,
    input: {
      pageSize: number;
      cursor: NotificationCursor | null;
    },
  ): Promise<{ items: Notification[]; hasMore: boolean }> {
    const cursorCondition = input.cursor
      ? or(
          sql`${pacaNotifications.createdAt} < ${input.cursor.createdAt}::timestamptz`,
          and(
            sql`${pacaNotifications.createdAt} = ${input.cursor.createdAt}::timestamptz`,
            sql`${pacaNotifications.id} < ${input.cursor.id}::uuid`,
          ),
        )
      : undefined;
    const rows = await this.database
      .select({
        id: pacaNotifications.id,
        type: pacaNotifications.type,
        actorType: pacaNotifications.actorType,
        actorUserName: user.name,
        actorUserEmail: user.email,
        actorUserImage: user.image,
        actorAgentName: agent.name,
        taskId: pacaNotifications.taskId,
        taskTitle: pacaTasks.title,
        taskNumber: pacaTasks.taskNumber,
        projectId: pacaNotifications.projectId,
        projectName: pacaProjects.name,
        readAt: pacaNotifications.readAt,
        createdAt: pacaNotifications.createdAt,
        cursorCreatedAt: sql<string>`to_char(${pacaNotifications.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(pacaNotifications)
      .innerJoin(
        pacaProjectMembers,
        and(
          eq(pacaProjectMembers.projectId, pacaNotifications.projectId),
          eq(pacaProjectMembers.userId, userId),
        ),
      )
      .innerJoin(pacaTasks, eq(pacaTasks.id, pacaNotifications.taskId))
      .innerJoin(pacaProjects, eq(pacaProjects.id, pacaNotifications.projectId))
      .leftJoin(user, eq(user.id, pacaNotifications.actorUserId))
      .leftJoin(agent, eq(agent.id, pacaNotifications.actorAgentId))
      .where(and(eq(pacaNotifications.recipientUserId, userId), cursorCondition))
      .orderBy(desc(pacaNotifications.createdAt), desc(pacaNotifications.id))
      .limit(input.pageSize + 1);
    const hasMore = rows.length > input.pageSize;
    return {
      items: (hasMore ? rows.slice(0, input.pageSize) : rows).map(fromRow),
      hasMore,
    };
  }

  async unreadCount(userId: string): Promise<number> {
    const [row] = await this.database
      .select({ value: count() })
      .from(pacaNotifications)
      .innerJoin(
        pacaProjectMembers,
        and(
          eq(pacaProjectMembers.projectId, pacaNotifications.projectId),
          eq(pacaProjectMembers.userId, userId),
        ),
      )
      .where(and(eq(pacaNotifications.recipientUserId, userId), isNull(pacaNotifications.readAt)));
    return Number(row?.value ?? 0);
  }

  async markAsRead(userId: string, notificationId: string, now: Date): Promise<boolean> {
    const [row] = await this.database
      .update(pacaNotifications)
      .set({ readAt: now })
      .where(
        and(
          eq(pacaNotifications.id, notificationId),
          eq(pacaNotifications.recipientUserId, userId),
        ),
      )
      .returning({ id: pacaNotifications.id });
    return Boolean(row);
  }

  async markAllAsRead(userId: string, now: Date): Promise<void> {
    await this.database
      .update(pacaNotifications)
      .set({ readAt: now })
      .where(and(eq(pacaNotifications.recipientUserId, userId), isNull(pacaNotifications.readAt)));
  }
}
