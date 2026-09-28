import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

import * as schema from "../../src/db/schema";
import {
  organization,
  pacaProjects,
  pacaTaskActivities,
  pacaTaskMutationIdempotency,
  pacaTasks,
  user,
} from "../../src/db/schema";
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
      const [task] = await database
        .insert(pacaTasks)
        .values({ projectId: project.id, taskNumber: 1, title: "Before" })
        .returning();
      if (!task) throw new Error("AUTOMATION_ACTION_TASK_MISSING");

      const service = new TaskService(new PostgresTaskRepository(database));
      const update = { title: "After", importance: 9, tags: ["review"] };
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
