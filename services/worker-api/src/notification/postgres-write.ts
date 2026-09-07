import { and, eq, inArray } from "drizzle-orm";

import type { PacaDatabase } from "../database";
import { pacaNotifications, pacaProjectMembers, pacaRealtimeOutbox } from "../db/schema";
import type { TaskActor } from "../task/service";
import type { NotificationType } from "./service";

type NotificationWriteDatabase = Pick<PacaDatabase, "insert" | "select">;

type TaskNotificationInput = {
  projectId: string;
  taskId: string;
  sourceActivityId: string;
  actor: TaskActor;
};

function actorColumns(actor: TaskActor) {
  return actor.type === "user"
    ? { actorType: "user", actorUserId: actor.id, actorAgentId: null }
    : { actorType: "agent", actorUserId: null, actorAgentId: actor.id };
}

async function persistNotifications(
  database: NotificationWriteDatabase,
  input: TaskNotificationInput & {
    type: NotificationType;
    recipientUserIds: string[];
  },
): Promise<number> {
  const recipientUserIds = [
    ...new Set(
      input.recipientUserIds.filter(
        (userId) => userId && !(input.actor.type === "user" && input.actor.id === userId),
      ),
    ),
  ];
  if (recipientUserIds.length === 0) return 0;

  const rows = recipientUserIds.map((recipientUserId) => ({
    id: crypto.randomUUID(),
    recipientUserId,
    ...actorColumns(input.actor),
    type: input.type,
    taskId: input.taskId,
    projectId: input.projectId,
    sourceActivityId: input.sourceActivityId,
  }));
  const inserted = await database
    .insert(pacaNotifications)
    .values(rows)
    .onConflictDoNothing({
      target: [
        pacaNotifications.sourceActivityId,
        pacaNotifications.recipientUserId,
        pacaNotifications.type,
      ],
    })
    .returning({
      id: pacaNotifications.id,
      recipientUserId: pacaNotifications.recipientUserId,
    });
  if (inserted.length === 0) return 0;

  await database.insert(pacaRealtimeOutbox).values(
    inserted.map((notification) => ({
      id: crypto.randomUUID(),
      roomType: "user",
      roomId: notification.recipientUserId,
      eventType: "notification.created",
      payload: {
        notification_id: notification.id,
        notification_type: input.type,
        recipient_user_id: notification.recipientUserId,
        project_id: input.projectId,
        task_id: input.taskId,
      },
    })),
  );
  return inserted.length;
}

export async function createAssignmentNotifications(
  database: NotificationWriteDatabase,
  input: TaskNotificationInput & { addedAssigneeMemberIds: string[] },
): Promise<number> {
  const memberIds = [...new Set(input.addedAssigneeMemberIds)];
  if (memberIds.length === 0) return 0;
  const members = await database
    .select({ userId: pacaProjectMembers.userId })
    .from(pacaProjectMembers)
    .where(
      and(
        eq(pacaProjectMembers.projectId, input.projectId),
        inArray(pacaProjectMembers.id, memberIds),
      ),
    );
  return persistNotifications(database, {
    ...input,
    type: "assigned",
    recipientUserIds: members.map(({ userId }) => userId),
  });
}

export function extractMentionedUserIds(content: unknown[]): string[] {
  const result = new Set<string>();
  for (const block of content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const inline = (block as Record<string, unknown>).content;
    if (!Array.isArray(inline)) continue;
    for (const item of inline) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      if (record.type !== "teamMention") continue;
      const props = record.props;
      if (!props || typeof props !== "object" || Array.isArray(props)) continue;
      const id = (props as Record<string, unknown>).id;
      if (typeof id === "string" && id.length > 0 && id.length <= 255) result.add(id);
    }
  }
  return [...result];
}

export async function createMentionNotifications(
  database: NotificationWriteDatabase,
  input: TaskNotificationInput & { content: unknown[] },
): Promise<number> {
  const mentionedUserIds = extractMentionedUserIds(input.content);
  if (mentionedUserIds.length === 0) return 0;
  const members = await database
    .select({ userId: pacaProjectMembers.userId })
    .from(pacaProjectMembers)
    .where(
      and(
        eq(pacaProjectMembers.projectId, input.projectId),
        inArray(pacaProjectMembers.userId, mentionedUserIds),
      ),
    );
  return persistNotifications(database, {
    ...input,
    type: "mentioned",
    recipientUserIds: members.map(({ userId }) => userId),
  });
}
