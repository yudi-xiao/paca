import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

import { PostgresAutomationRunPlanner } from "../../src/automation/run-planner";
import { automationRunSnapshotSchema } from "../../src/automation/run-protocol";
import * as schema from "../../src/db/schema";
import {
  organization,
  pacaAutomationEdges,
  pacaAutomationEventOutbox,
  pacaAutomationNodes,
  pacaAutomationRuns,
  pacaAutomations,
  pacaProjects,
  pacaTasks,
  user,
} from "../../src/db/schema";

const databaseURL = process.env.PACA_TEST_DATABASE_URL?.trim();
if (process.env.PACA_REQUIRE_POSTGRES_CONTRACTS === "true" && !databaseURL) {
  throw new Error("PACA_TEST_DATABASE_URL_REQUIRED");
}

(databaseURL ? describe : describe.skip)("PostgreSQL Automation Run planning", () => {
  it("captures an event graph once and returns the same Run on repeated Queue deliveries", async () => {
    if (!databaseURL) throw new Error("PACA_TEST_DATABASE_URL_REQUIRED");
    const client = new Client({ connectionString: databaseURL, connectionTimeoutMillis: 5_000 });
    await client.connect();
    const database = drizzle(client, { schema });
    const suffix = crypto.randomUUID();
    const userId = `automation-plan-${suffix}`;
    const organizationId = `automation-plan-org-${suffix}`;
    try {
      await database.insert(user).values({
        id: userId,
        name: "Automation Plan User",
        email: `${userId}@paca.test`,
        emailVerified: true,
      });
      await database.insert(organization).values({
        id: organizationId,
        name: "Automation Plan Org",
        slug: organizationId,
        createdAt: new Date(),
      });
      const [project] = await database
        .insert(pacaProjects)
        .values({ organizationId, name: "Planner", slug: `planner-${suffix}`, createdBy: userId })
        .returning();
      if (!project) throw new Error("AUTOMATION_PLAN_PROJECT_MISSING");
      const [automation] = await database
        .insert(pacaAutomations)
        .values({ projectId: project.id, name: "On create", status: "active", createdBy: userId })
        .returning();
      if (!automation) throw new Error("AUTOMATION_PLAN_AUTOMATION_MISSING");
      const [trigger, wait] = await database
        .insert(pacaAutomationNodes)
        .values([
          { automationId: automation.id, kind: "trigger", type: "task_created", config: {} },
          {
            automationId: automation.id,
            kind: "action",
            type: "wait",
            config: { wait_minutes: 1 },
          },
        ])
        .returning();
      if (!trigger || !wait) throw new Error("AUTOMATION_PLAN_NODES_MISSING");
      await database.insert(pacaAutomationEdges).values({
        automationId: automation.id,
        sourceNodeId: trigger.id,
        targetNodeId: wait.id,
      });
      const [task] = await database
        .insert(pacaTasks)
        .values({ projectId: project.id, taskNumber: 1, title: "Trigger planner" })
        .returning();
      if (!task) throw new Error("AUTOMATION_PLAN_TASK_MISSING");
      const [event] = await database
        .select()
        .from(pacaAutomationEventOutbox)
        .where(eq(pacaAutomationEventOutbox.taskId, task.id));
      if (!event) throw new Error("AUTOMATION_PLAN_EVENT_MISSING");
      const planner = new PostgresAutomationRunPlanner(database);
      const first = await planner.plan(event.id);
      const second = await planner.plan(event.id);
      expect(first).toHaveLength(1);
      expect(second).toEqual(first);
      const [run] = await database
        .select()
        .from(pacaAutomationRuns)
        .where(eq(pacaAutomationRuns.id, first[0] as string));
      if (!run) throw new Error("AUTOMATION_PLAN_RUN_MISSING");
      expect(run.eventKey).toBe(`${event.id}:${trigger.id}`);
      expect(run.taskId).toBe(task.id);
      const snapshot = automationRunSnapshotSchema.parse(run.graphSnapshot);
      expect(snapshot.event.id).toBe(event.id);
      expect(snapshot.nodes.find((node) => node.id === wait.id)?.config).toEqual({
        wait_minutes: 1,
      });
      await database
        .update(pacaAutomationNodes)
        .set({ config: { wait_minutes: 2 } })
        .where(eq(pacaAutomationNodes.id, wait.id));
      await database
        .update(pacaAutomations)
        .set({ graphVersion: 2, updatedAt: new Date(event.createdAt.getTime() + 1_000) })
        .where(eq(pacaAutomations.id, automation.id));
      expect(await planner.plan(event.id)).toEqual(first);
      const runsAfterEdit = await database
        .select()
        .from(pacaAutomationRuns)
        .where(eq(pacaAutomationRuns.automationId, automation.id));
      expect(runsAfterEdit).toHaveLength(1);
      expect(
        automationRunSnapshotSchema
          .parse(runsAfterEdit[0]?.graphSnapshot)
          .nodes.find((node) => node.id === wait.id)?.config,
      ).toEqual({ wait_minutes: 1 });
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
