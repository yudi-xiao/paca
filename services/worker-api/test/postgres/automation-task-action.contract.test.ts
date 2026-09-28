import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

import { taskUpdateFromNode } from "../../src/automation/execution-plan";
import * as schema from "../../src/db/schema";
import {
  organization,
  pacaNotifications,
  pacaProjectMembers,
  pacaProjects,
  pacaSprints,
  pacaTaskActivities,
  pacaTaskMutationIdempotency,
  pacaTaskStatuses,
  pacaTasks,
  pacaTaskTypes,
  user,
} from "../../src/db/schema";
import { PostgresNotificationRepository } from "../../src/notification/postgres-repository";
import { PostgresTaskRepository } from "../../src/task/postgres-repository";
import { automationTaskActor, TaskService } from "../../src/task/service";

const databaseURL = process.env.PACA_TEST_DATABASE_URL?.trim();
if (process.env.PACA_REQUIRE_POSTGRES_CONTRACTS === "true" && !databaseURL) {
  throw new Error("PACA_TEST_DATABASE_URL_REQUIRED");
}

(databaseURL ? describe : describe.skip)("PostgreSQL Automation task action", () => {
  it("records one system-authored change and one marker across a repeated Workflow step", async () => {
    if (!databaseURL) throw new Error("PACA_TEST_DATABASE_URL_REQUIRED");
    const client = new Client({ connectionString: databaseURL, connectionTimeoutMillis: 5_000 });
    await client.connect();
    const database = drizzle(client, { schema });
    const suffix = crypto.randomUUID();
    const userId = `automation-action-${suffix}`;
    const organizationId = `automation-action-org-${suffix}`;
    const runId = crypto.randomUUID();
    const nodeId = crypto.randomUUID();
    try {
      await database.insert(user).values({
        id: userId,
        name: "Automation Action User",
        email: `${userId}@paca.test`,
        emailVerified: true,
      });
      await database.insert(organization).values({
        id: organizationId,
        name: "Automation Action Org",
        slug: organizationId,
        createdAt: new Date(),
      });
      const [project] = await database
        .insert(pacaProjects)
        .values({ organizationId, name: "Action", slug: `action-${suffix}`, createdBy: userId })
        .returning();
      if (!project) throw new Error("AUTOMATION_ACTION_PROJECT_MISSING");
      const [member] = await database
        .insert(pacaProjectMembers)
        .values({ projectId: project.id, userId })
        .returning();
      const [status] = await database
        .insert(pacaTaskStatuses)
        .values({ projectId: project.id, name: "Ready", category: "ready" })
        .returning();
      const [taskType] = await database
        .insert(pacaTaskTypes)
        .values({ projectId: project.id, name: "Story" })
        .returning();
      const [sprint] = await database
        .insert(pacaSprints)
        .values({ projectId: project.id, name: "Sprint 1" })
        .returning();
      const [parent, task] = await database
        .insert(pacaTasks)
        .values([
          { projectId: project.id, taskNumber: 1, title: "Parent" },
          { projectId: project.id, taskNumber: 2, title: "Before" },
        ])
        .returning();
      if (!task || !parent || !status || !taskType || !sprint || !member) {
        throw new Error("AUTOMATION_ACTION_FIXTURE_MISSING");
      }

      const service = new TaskService(new PostgresTaskRepository(database));
      const update = taskUpdateFromNode({
        kind: "action",
        type: "update_task",
        config: {
          update: {
            title: "After",
            status_id: status.id,
            task_type_id: taskType.id,
            sprint_id: sprint.id,
            parent_task_id: parent.id,
            description: [{ type: "paragraph", content: [] }],
            importance: 9,
            assignee_ids: [member.id],
            start_date: "2026-09-28T00:00:00Z",
            due_date: "2026-10-01T00:00:00Z",
            tags: ["review"],
          },
        },
      });
      const operationKey = `${runId}:${nodeId}`;
      const first = await service.updateAs(
        project.id,
        task.id,
        automationTaskActor(runId),
        update,
        operationKey,
      );
      const second = await service.updateAs(
        project.id,
        task.id,
        automationTaskActor(runId),
        update,
        operationKey,
      );
      expect(first.title).toBe("After");
      expect(first.tags).toEqual(["review"]);
      expect(first).toMatchObject({
        statusId: status.id,
        taskTypeId: taskType.id,
        sprintId: sprint.id,
        parentTaskId: parent.id,
        description: [{ type: "paragraph", content: [] }],
        startDate: "2026-09-28",
        dueDate: "2026-10-01",
        assigneeIds: [member.id],
      });
      expect(second.updatedAt).toEqual(first.updatedAt);

      const activities = await database
        .select()
        .from(pacaTaskActivities)
        .where(
          and(eq(pacaTaskActivities.projectId, project.id), eq(pacaTaskActivities.taskId, task.id)),
        );
      expect(activities).toHaveLength(1);
      expect(activities[0]).toMatchObject({
        actorType: "system",
        actorId: "system",
        activityType: "task.updated",
      });
      expect(activities[0]?.content).toMatchObject({ automation_run_id: runId });
      const markers = await database
        .select()
        .from(pacaTaskMutationIdempotency)
        .where(eq(pacaTaskMutationIdempotency.taskId, task.id));
      expect(markers).toHaveLength(1);
      expect(markers[0]?.operationKey).toBe(operationKey);
      const notifications = await database
        .select()
        .from(pacaNotifications)
        .where(eq(pacaNotifications.taskId, task.id));
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        actorType: "system",
        actorUserId: null,
        actorAgentId: null,
        recipientUserId: userId,
      });
      const projected = await new PostgresNotificationRepository(database).list(userId, {
        pageSize: 10,
        cursor: null,
      });
      expect(projected.items).toMatchObject([
        { actorFullName: "Automation", actorMemberType: "system", type: "assigned" },
      ]);
    } finally {
      try {
        await database.delete(organization).where(eq(organization.id, organizationId));
        await database.delete(user).where(eq(user.id, userId));
      } finally {
        await client.end();
      }
    }
  });
});
