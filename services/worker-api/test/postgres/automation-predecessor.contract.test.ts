import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

import { PostgresAutomationRepository } from "../../src/automation/postgres-repository";
import { PostgresAutomationRunPlanner } from "../../src/automation/run-planner";
import * as schema from "../../src/db/schema";
import {
  organization,
  pacaAutomationEdges,
  pacaAutomationEventOutbox,
  pacaAutomationNodes,
  pacaAutomationRuns,
  pacaAutomations,
  pacaProjectMembers,
  pacaProjects,
  pacaTaskStatuses,
  pacaTasks,
  user,
} from "../../src/db/schema";
import { PostgresTaskRepository } from "../../src/task/postgres-repository";
import { TaskService, userTaskActor } from "../../src/task/service";

const databaseURL = process.env.PACA_TEST_DATABASE_URL?.trim();
if (process.env.PACA_REQUIRE_POSTGRES_CONTRACTS === "true" && !databaseURL) {
  throw new Error("PACA_TEST_DATABASE_URL_REQUIRED");
}

(databaseURL ? describe : describe.skip)("PostgreSQL predecessor_done Automation", () => {
  it("waits for all watched tasks, runs against the target, and ignores Done-to-Done edits", async () => {
    if (!databaseURL) throw new Error("PACA_TEST_DATABASE_URL_REQUIRED");
    const client = new Client({ connectionString: databaseURL, connectionTimeoutMillis: 5_000 });
    await client.connect();
    const database = drizzle(client, { schema });
    const suffix = crypto.randomUUID();
    const userId = `automation-predecessor-${suffix}`;
    const organizationId = `automation-predecessor-org-${suffix}`;
    try {
      await database.insert(user).values({
        id: userId,
        name: "Predecessor User",
        email: `${userId}@paca.test`,
        emailVerified: true,
      });
      await database.insert(organization).values({
        id: organizationId,
        name: "Predecessor Org",
        slug: organizationId,
        createdAt: new Date(),
      });
      const [project] = await database
        .insert(pacaProjects)
        .values({ organizationId, name: "Predecessor", slug: `pred-${suffix}`, createdBy: userId })
        .returning();
      if (!project) throw new Error("AUTOMATION_PREDECESSOR_PROJECT_MISSING");
      const [otherProject] = await database
        .insert(pacaProjects)
        .values({ organizationId, name: "Other", slug: `other-${suffix}`, createdBy: userId })
        .returning();
      if (!otherProject) throw new Error("AUTOMATION_PREDECESSOR_OTHER_PROJECT_MISSING");
      const [otherTask] = await database
        .insert(pacaTasks)
        .values({ projectId: otherProject.id, taskNumber: 1, title: "Foreign target" })
        .returning();
      if (!otherTask) throw new Error("AUTOMATION_PREDECESSOR_OTHER_TASK_MISSING");
      await database.insert(pacaProjectMembers).values({ projectId: project.id, userId });
      const [todo, done, doneAlternate] = await database
        .insert(pacaTaskStatuses)
        .values([
          { projectId: project.id, name: "Todo", category: "todo" },
          { projectId: project.id, name: "Done", category: "done" },
          { projectId: project.id, name: "Done Alternate", category: "done" },
        ])
        .returning();
      if (!todo || !done || !doneAlternate) {
        throw new Error("AUTOMATION_PREDECESSOR_STATUS_MISSING");
      }
      const [first, second, target] = await database
        .insert(pacaTasks)
        .values([
          { projectId: project.id, taskNumber: 1, title: "First", statusId: todo.id },
          { projectId: project.id, taskNumber: 2, title: "Second", statusId: todo.id },
          { projectId: project.id, taskNumber: 3, title: "Target", statusId: todo.id },
        ])
        .returning();
      if (!first || !second || !target) throw new Error("AUTOMATION_PREDECESSOR_TASK_MISSING");
      const [automation] = await database
        .insert(pacaAutomations)
        .values({ projectId: project.id, name: "Predecessor", createdBy: userId })
        .returning();
      if (!automation) throw new Error("AUTOMATION_PREDECESSOR_GRAPH_MISSING");
      const [trigger, action] = await database
        .insert(pacaAutomationNodes)
        .values([
          {
            automationId: automation.id,
            kind: "trigger",
            type: "predecessor_done",
            config: { target_task_id: target.id, watched_task_ids: [first.id, second.id] },
          },
          {
            automationId: automation.id,
            kind: "action",
            type: "wait",
            config: { wait_minutes: 1 },
          },
        ])
        .returning();
      if (!trigger || !action) throw new Error("AUTOMATION_PREDECESSOR_NODES_MISSING");
      await database.insert(pacaAutomationEdges).values({
        automationId: automation.id,
        sourceNodeId: trigger.id,
        targetNodeId: action.id,
      });
      const graph = new PostgresAutomationRepository(database);
      await database
        .update(pacaAutomationNodes)
        .set({
          config: { target_task_id: otherTask.id, watched_task_ids: [first.id, second.id] },
        })
        .where(eq(pacaAutomationNodes.id, trigger.id));
      await expect(graph.setActive(project.id, automation.id, true)).rejects.toThrow(
        "AUTOMATION_TRIGGER_TASK_NOT_FOUND",
      );
      await database
        .update(pacaAutomationNodes)
        .set({ config: { target_task_id: target.id, watched_task_ids: [first.id, second.id] } })
        .where(eq(pacaAutomationNodes.id, trigger.id));
      await graph.setActive(project.id, automation.id, true);
      const tasks = new TaskService(new PostgresTaskRepository(database));
      const planner = new PostgresAutomationRunPlanner(database);

      await tasks.updateAs(project.id, first.id, userTaskActor(userId), { statusId: done.id });
      const firstEvents = await database
        .select()
        .from(pacaAutomationEventOutbox)
        .where(
          and(
            eq(pacaAutomationEventOutbox.taskId, first.id),
            eq(pacaAutomationEventOutbox.eventType, "predecessor_done"),
          ),
        );
      expect(firstEvents).toEqual([]);

      await tasks.updateAs(project.id, second.id, userTaskActor(userId), { statusId: done.id });
      const [secondEvent] = await database
        .select()
        .from(pacaAutomationEventOutbox)
        .where(
          and(
            eq(pacaAutomationEventOutbox.taskId, second.id),
            eq(pacaAutomationEventOutbox.eventType, "predecessor_done"),
          ),
        );
      if (!secondEvent) throw new Error("AUTOMATION_PREDECESSOR_SECOND_EVENT_MISSING");
      const [runId] = await planner.plan(secondEvent.id);
      if (!runId) throw new Error("AUTOMATION_PREDECESSOR_RUN_MISSING");
      expect(await planner.plan(secondEvent.id)).toEqual([runId]);
      const [run] = await database
        .select()
        .from(pacaAutomationRuns)
        .where(eq(pacaAutomationRuns.id, runId));
      expect(run?.taskId).toBe(target.id);
      expect(run?.graphSnapshot).toMatchObject({
        event: { taskId: target.id, payload: { watched_task_id: second.id } },
      });

      await tasks.updateAs(project.id, second.id, userTaskActor(userId), {
        statusId: doneAlternate.id,
      });
      expect(
        await database
          .select()
          .from(pacaAutomationEventOutbox)
          .where(
            and(
              eq(pacaAutomationEventOutbox.taskId, second.id),
              eq(pacaAutomationEventOutbox.eventType, "predecessor_done"),
            ),
          ),
      ).toHaveLength(1);

      await tasks.updateAs(project.id, first.id, userTaskActor(userId), { statusId: todo.id });
      await tasks.updateAs(project.id, second.id, userTaskActor(userId), { statusId: todo.id });
      const firstClient = new Client({
        connectionString: databaseURL,
        connectionTimeoutMillis: 5_000,
      });
      const secondClient = new Client({
        connectionString: databaseURL,
        connectionTimeoutMillis: 5_000,
      });
      await Promise.all([firstClient.connect(), secondClient.connect()]);
      let secondUpdate: Promise<unknown> | null = null;
      try {
        await firstClient.query("BEGIN");
        await secondClient.query("BEGIN");
        await secondClient.query("SET LOCAL statement_timeout = '5s'");
        await firstClient.query("UPDATE paca_task SET status_id = $1 WHERE id = $2", [
          done.id,
          first.id,
        ]);
        const backend = await secondClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const secondPid = backend.rows[0]?.pid;
        if (!secondPid) throw new Error("AUTOMATION_PREDECESSOR_BACKEND_MISSING");
        secondUpdate = secondClient.query("UPDATE paca_task SET status_id = $1 WHERE id = $2", [
          done.id,
          second.id,
        ]);
        let waitedForGraphLock = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const activity = await client.query<{ wait_event_type: string | null }>(
            "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
            [secondPid],
          );
          if (activity.rows[0]?.wait_event_type === "Lock") {
            waitedForGraphLock = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waitedForGraphLock).toBe(true);
        await firstClient.query("COMMIT");
        await secondUpdate;
        await secondClient.query("COMMIT");
      } finally {
        await firstClient.query("ROLLBACK").catch(() => undefined);
        if (secondUpdate) await secondUpdate.catch(() => undefined);
        await secondClient.query("ROLLBACK").catch(() => undefined);
        await Promise.all([firstClient.end(), secondClient.end()]);
      }
      const completionEvents = await database
        .select()
        .from(pacaAutomationEventOutbox)
        .where(
          and(
            eq(pacaAutomationEventOutbox.projectId, project.id),
            eq(pacaAutomationEventOutbox.eventType, "predecessor_done"),
          ),
        );
      expect(completionEvents).toHaveLength(2);
      const concurrentEvent = completionEvents.find((event) => event.id !== secondEvent.id);
      if (!concurrentEvent) throw new Error("AUTOMATION_PREDECESSOR_CONCURRENT_EVENT_MISSING");
      expect(concurrentEvent.payload.eligible_trigger_ids).toEqual([trigger.id]);
      expect(await planner.plan(concurrentEvent.id)).toHaveLength(1);
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
