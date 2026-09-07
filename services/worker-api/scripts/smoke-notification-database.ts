import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import * as z from "zod";

import * as schema from "../src/db/schema";
import { pacaProjectMembers, pacaProjects, pacaRealtimeOutbox, user } from "../src/db/schema";
import { PostgresNotificationRepository } from "../src/notification/postgres-repository";
import { NotificationService } from "../src/notification/service";
import { DEFAULT_ORGANIZATION_ID } from "../src/permission/postgres-store";
import { PostgresProjectRepository } from "../src/project/postgres-repository";
import { ProjectService } from "../src/project/service";
import { PostgresTaskRepository } from "../src/task/postgres-repository";
import { TaskService } from "../src/task/service";

const input = z
  .object({ databaseUrl: z.url() })
  .parse({ databaseUrl: process.env.PACA_SMOKE_DATABASE_URL });

const connectionUrl = new URL(input.databaseUrl);
connectionUrl.searchParams.delete("sslrootcert");
connectionUrl.searchParams.delete("sslmode");

const client = new Client({
  connectionString: connectionUrl.toString(),
  connectionTimeoutMillis: 8_000,
  query_timeout: 8_000,
  ssl: { rejectUnauthorized: true },
});

await client.connect();
const database = drizzle(client, { schema });
let projectId: string | null = null;
let recipientId: string | null = null;

try {
  const [actor] = await database.select({ id: user.id }).from(user).limit(1);
  if (!actor) throw new Error("NOTIFICATION_SMOKE_REQUIRES_EXISTING_USER");

  recipientId = `notification-smoke-${crypto.randomUUID()}`;
  await database.insert(user).values({
    id: recipientId,
    name: "Notification smoke recipient",
    email: `${recipientId}@example.invalid`,
    emailVerified: true,
  });

  const project = await new ProjectService(new PostgresProjectRepository(database)).create(
    DEFAULT_ORGANIZATION_ID,
    actor.id,
    {
      name: `Notification smoke ${crypto.randomUUID().slice(0, 8)}`,
      taskIdPrefix: "NOTIFY",
    },
  );
  projectId = project.id;

  const recipientMemberId = crypto.randomUUID();
  await database.insert(pacaProjectMembers).values({
    id: recipientMemberId,
    projectId: project.id,
    userId: recipientId,
  });

  const task = await new TaskService(new PostgresTaskRepository(database)).create(
    project.id,
    actor.id,
    {
      title: "Notification smoke task",
      assigneeIds: [recipientMemberId],
    },
  );

  const service = new NotificationService(new PostgresNotificationRepository(database));
  const firstPage = await service.list(recipientId, { pageSize: 10 });
  const created = firstPage.items.find(
    (notification) => notification.projectId === project.id && notification.taskId === task.id,
  );
  if (!created || created.type !== "assigned" || firstPage.unreadCount < 1) {
    throw new Error("NOTIFICATION_SMOKE_ASSIGNMENT_INVALID");
  }

  const [outbox] = await database
    .select({ eventType: pacaRealtimeOutbox.eventType, roomId: pacaRealtimeOutbox.roomId })
    .from(pacaRealtimeOutbox)
    .where(
      and(
        eq(pacaRealtimeOutbox.eventType, "notification.created"),
        eq(pacaRealtimeOutbox.roomId, recipientId),
        sql`${pacaRealtimeOutbox.payload}->>'notification_id' = ${created.id}`,
      ),
    )
    .limit(1);
  if (!outbox) throw new Error("NOTIFICATION_SMOKE_OUTBOX_MISSING");

  await service.markAsRead(recipientId, created.id);
  const afterRead = await service.list(recipientId, { pageSize: 10 });
  const readNotification = afterRead.items.find(({ id }) => id === created.id);
  if (!readNotification?.readAt || afterRead.unreadCount !== firstPage.unreadCount - 1) {
    throw new Error("NOTIFICATION_SMOKE_READ_INVALID");
  }

  await service.markAllAsRead(recipientId);
  const afterReadAll = await service.list(recipientId, { pageSize: 10 });
  if (afterReadAll.unreadCount !== 0) {
    throw new Error("NOTIFICATION_SMOKE_READ_ALL_INVALID");
  }

  console.log(
    JSON.stringify({
      status: "ok",
      step: "notification-database-smoke",
      notificationType: created.type,
      realtimeEventType: outbox.eventType,
    }),
  );
} finally {
  if (projectId) {
    await database.delete(pacaProjects).where(eq(pacaProjects.id, projectId));
    await database
      .delete(pacaRealtimeOutbox)
      .where(sql`${pacaRealtimeOutbox.payload}->>'project_id' = ${projectId}`);
  }
  if (recipientId) await database.delete(user).where(eq(user.id, recipientId));
  await client.end();
}
