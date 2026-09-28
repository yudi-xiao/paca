import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

import { PostgresAutomationRunPlanner } from "../../src/automation/run-planner";
import * as schema from "../../src/db/schema";
import {
  organization,
  pacaAutomationEdges,
  pacaAutomationEventOutbox,
  pacaAutomationNodes,
  pacaAutomations,
  pacaProjectMembers,
  pacaProjects,
  pacaTasks,
  user,
} from "../../src/db/schema";
import { PostgresTaskRepository } from "../../src/task/postgres-repository";
import { TaskService, userTaskActor } from "../../src/task/service";

const databaseURL = process.env.PACA_TEST_DATABASE_URL?.trim();
if (process.env.PACA_REQUIRE_POSTGRES_CONTRACTS === "true" && !databaseURL) {
  throw new Error("PACA_TEST_DATABASE_URL_REQUIRED");
}

(databaseURL ? describe : describe.skip)("PostgreSQL Automation task field events", () => {
  it("captures independent assignment, priority and added-tag events exactly once", async () => {
    if (!databaseURL) throw new Error("PACA_TEST_DATABASE_URL_REQUIRED");
    const client = new Client({ connectionString: databaseURL, connectionTimeoutMillis: 5_000 });
    await client.connect();
    const database = drizzle(client, { schema });
    const suffix = crypto.randomUUID();
    const userId = `automation-fields-${suffix}`;
    const organizationId = `automation-fields-org-${suffix}`;
    try {
      await database.insert(user).values({
        id: userId,
        name: "Automation Fields User",
        email: `${userId}@paca.test`,
        emailVerified: true,
      });
      await database.insert(organization).values({
        id: organizationId,
        name: "Automation Fields Org",
        slug: organizationId,
        createdAt: new Date(),
      });
      const [project] = await database
        .insert(pacaProjects)
        .values({
          organizationId,
          name: "Field events",
          slug: `events-${suffix}`,
          createdBy: userId,
        })
        .returning();
      if (!project) throw new Error("AUTOMATION_FIELDS_PROJECT_MISSING");
      const [member] = await database
        .insert(pacaProjectMembers)
        .values({ projectId: project.id, userId })
        .returning();
      if (!member) throw new Error("AUTOMATION_FIELDS_MEMBER_MISSING");
      const [automation] = await database
        .insert(pacaAutomations)
        .values({
          projectId: project.id,
          name: "Field events",
          status: "active",
          createdBy: userId,
        })
        .returning();
      if (!automation) throw new Error("AUTOMATION_FIELDS_GRAPH_MISSING");
      const [assignee, priority, tag, unmatchedTag, wait] = await database
        .insert(pacaAutomationNodes)
        .values([
          { automationId: automation.id, kind: "trigger", type: "assignee_changed", config: {} },
          { automationId: automation.id, kind: "trigger", type: "priority_changed", config: {} },
          {
            automationId: automation.id,
            kind: "trigger",
            type: "tag_added",
            config: { tag: "urgent" },
          },
          {
            automationId: automation.id,
            kind: "trigger",
            type: "tag_added",
            config: { tag: "missing" },
          },
          {
            automationId: automation.id,
            kind: "action",
            type: "wait",
            config: { wait_minutes: 1 },
          },
        ])
        .returning();
      if (!assignee || !priority || !tag || !unmatchedTag || !wait) {
        throw new Error("AUTOMATION_FIELDS_NODES_MISSING");
      }
      await database.insert(pacaAutomationEdges).values(
        [assignee, priority, tag, unmatchedTag].map((trigger) => ({
          automationId: automation.id,
          sourceNodeId: trigger.id,
          targetNodeId: wait.id,
        })),
      );
      const [task] = await database
        .insert(pacaTasks)
        .values({ projectId: project.id, taskNumber: 1, title: "Task", tags: ["keep"] })
        .returning();
      if (!task) throw new Error("AUTOMATION_FIELDS_TASK_MISSING");
      const service = new TaskService(new PostgresTaskRepository(database));
      await service.updateAs(project.id, task.id, userTaskActor(userId), {
        assigneeIds: [member.id],
        importance: 5,
        tags: ["keep", "urgent"],
      });
      const events = await database
        .select()
        .from(pacaAutomationEventOutbox)
        .where(eq(pacaAutomationEventOutbox.taskId, task.id));
      expect(events.map((event) => event.eventType).sort()).toEqual([
        "assignee_changed",
        "priority_changed",
        "tag_added",
      ]);
      expect(events.find((event) => event.eventType === "assignee_changed")?.payload).toEqual({
        task_id: task.id,
        previous_assignee_ids: [],
        assignee_ids: [member.id],
      });
      expect(events.find((event) => event.eventType === "priority_changed")?.payload).toEqual({
        task_id: task.id,
        previous_importance: 0,
        importance: 5,
      });
      expect(events.find((event) => event.eventType === "tag_added")?.payload).toEqual({
        task_id: task.id,
        added_tags: ["urgent"],
      });
      const planner = new PostgresAutomationRunPlanner(database);
      for (const event of events) {
        expect(await planner.plan(event.id)).toHaveLength(1);
        expect(await planner.plan(event.id)).toHaveLength(1);
      }

      await service.updateAs(project.id, task.id, userTaskActor(userId), {
        assigneeIds: [member.id],
        importance: 5,
        tags: ["keep", "urgent"],
      });
      expect(
        await database
          .select()
          .from(pacaAutomationEventOutbox)
          .where(eq(pacaAutomationEventOutbox.taskId, task.id)),
      ).toHaveLength(3);

      await service.updateAs(project.id, task.id, userTaskActor(userId), {
        tags: ["keep", "extra"],
      });
      const tagEvents = await database
        .select()
        .from(pacaAutomationEventOutbox)
        .where(
          and(
            eq(pacaAutomationEventOutbox.taskId, task.id),
            eq(pacaAutomationEventOutbox.eventType, "tag_added"),
          ),
        );
      expect(tagEvents).toHaveLength(2);
      const extra = tagEvents.find(
        (event) =>
          Array.isArray(event.payload.added_tags) && event.payload.added_tags.includes("extra"),
      );
      if (!extra) throw new Error("AUTOMATION_FIELDS_EXTRA_EVENT_MISSING");
      expect(await planner.plan(extra.id)).toEqual([]);

      await database
        .update(pacaAutomations)
        .set({ status: "inactive" })
        .where(eq(pacaAutomations.id, automation.id));
      await service.updateAs(project.id, task.id, userTaskActor(userId), {
        assigneeIds: [],
        importance: 6,
        tags: ["keep", "extra", "later"],
      });
      expect(
        await database
          .select()
          .from(pacaAutomationEventOutbox)
          .where(eq(pacaAutomationEventOutbox.taskId, task.id)),
      ).toHaveLength(4);
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
