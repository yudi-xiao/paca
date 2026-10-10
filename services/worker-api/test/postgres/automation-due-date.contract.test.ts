import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresAutomationDueDateRepository } from "../../src/automation/due-date-scheduler";
import { PostgresAutomationOutboxRepository } from "../../src/automation/event-outbox";
import { PostgresAutomationRepository } from "../../src/automation/postgres-repository";
import { PostgresAutomationRunPlanner } from "../../src/automation/run-planner";
import type { PacaDatabase } from "../../src/database";
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
if (process.env.PACA_REQUIRE_POSTGRES_CONTRACTS === "true" && !databaseURL)
  throw new Error("PACA_TEST_DATABASE_URL_REQUIRED");

async function fixture(
  offsets: number[],
  run: (context: {
    client: Client;
    database: PacaDatabase;
    scheduler: PostgresAutomationDueDateRepository;
    planner: PostgresAutomationRunPlanner;
    graph: PostgresAutomationRepository;
    projectId: string;
    automationId: string;
    taskId: string;
    triggerIds: string[];
  }) => Promise<void>,
) {
  const client = new Client({ connectionString: databaseURL });
  await client.connect();
  const database = drizzle(client, { schema });
  const organizationId = `due-org-${crypto.randomUUID()}`;
  const userId = `due-user-${crypto.randomUUID()}`;
  try {
    await database
      .insert(user)
      .values({ id: userId, name: "Due User", email: `${userId}@paca.test`, emailVerified: true });
    await database.insert(organization).values({
      id: organizationId,
      name: "Due dates",
      slug: organizationId,
      createdAt: new Date(),
    });
    const [project] = await database
      .insert(pacaProjects)
      .values({ organizationId, name: "Due dates", slug: crypto.randomUUID(), createdBy: userId })
      .returning();
    if (!project) throw new Error("FIXTURE_PROJECT_MISSING");
    const [automation] = await database
      .insert(pacaAutomations)
      .values({ projectId: project.id, name: "Due dates" })
      .returning();
    if (!automation) throw new Error("FIXTURE_GRAPH_MISSING");
    const [task] = await database
      .insert(pacaTasks)
      .values({ projectId: project.id, taskNumber: 1, title: "Due", dueDate: "2001-01-02" })
      .returning();
    if (!task) throw new Error("FIXTURE_TASK_MISSING");
    const triggers = await database
      .insert(pacaAutomationNodes)
      .values(
        offsets.map((offset) => ({
          automationId: automation.id,
          kind: "trigger" as const,
          type: "due_date_reached",
          config: { due_date_offset_minutes: offset },
        })),
      )
      .returning();
    const [wait] = await database
      .insert(pacaAutomationNodes)
      .values({
        automationId: automation.id,
        kind: "action",
        type: "wait",
        config: { wait_minutes: 1 },
      })
      .returning();
    if (!wait) throw new Error("FIXTURE_ACTION_MISSING");
    await database.insert(pacaAutomationEdges).values(
      triggers.map((trigger) => ({
        automationId: automation.id,
        sourceNodeId: trigger.id,
        targetNodeId: wait.id,
      })),
    );
    const graph = new PostgresAutomationRepository(database);
    await graph.setActive(project.id, automation.id, true);
    await run({
      client,
      database,
      graph,
      scheduler: new PostgresAutomationDueDateRepository(database),
      planner: new PostgresAutomationRunPlanner(database),
      projectId: project.id,
      automationId: automation.id,
      taskId: task.id,
      triggerIds: triggers.map((trigger) => trigger.id),
    });
  } finally {
    try {
      await database.delete(organization).where(eq(organization.id, organizationId));
      await database.delete(user).where(eq(user.id, userId));
    } finally {
      await client.end();
    }
  }
}

async function dueEvents(database: PacaDatabase, taskId: string) {
  return database
    .select()
    .from(pacaAutomationEventOutbox)
    .where(
      and(
        eq(pacaAutomationEventOutbox.taskId, taskId),
        eq(pacaAutomationEventOutbox.eventType, "due_date_reached"),
      ),
    );
}
const time = (value: string) => new Date(value);

(databaseURL ? describe : describe.skip)("PostgreSQL due_date_reached Automation", () => {
  it("uses UTC midnight across database timezones and fires each offset node exactly once", async () => {
    await fixture(
      [-60, 0, 0, 60],
      async ({ client, database, scheduler, planner, taskId, projectId, triggerIds }) => {
        await client.query("SET TIME ZONE 'Pacific/Honolulu'");
        await database.insert(pacaTasks).values([
          { projectId, taskNumber: 2, title: "No due date" },
          {
            projectId,
            taskNumber: 3,
            title: "Deleted",
            dueDate: "2001-01-02",
            deletedAt: new Date(),
          },
        ]);
        expect(await scheduler.captureDue(time("2001-01-01T22:59:59Z"), 100)).toEqual({
          created: 0,
        });
        expect(await scheduler.captureDue(time("2001-01-01T23:00:00Z"), 100)).toEqual({
          created: 1,
        });
        expect(await scheduler.captureDue(time("2001-01-01T23:59:59Z"), 100)).toEqual({
          created: 0,
        });
        expect(await scheduler.captureDue(time("2001-01-02T00:00:00Z"), 100)).toEqual({
          created: 2,
        });
        expect(await scheduler.captureDue(time("2001-01-02T01:00:00Z"), 100)).toEqual({
          created: 1,
        });
        expect(await scheduler.captureDue(time("2001-01-03T00:00:00Z"), 100)).toEqual({
          created: 0,
        });
        const events = await dueEvents(database, taskId);
        expect(events).toHaveLength(4);
        const runs: string[] = [];
        for (const event of events) {
          const ids = await planner.plan(event.id);
          expect(ids).toHaveLength(1);
          expect(await planner.plan(event.id)).toEqual(ids);
          runs.push(...ids);
        }
        expect(new Set(runs).size).toBe(4);
        const rows = await database.select().from(pacaAutomationRuns);
        expect(
          rows
            .filter((row) => runs.includes(row.id))
            .map((row) => row.triggerNodeId)
            .sort(),
        ).toEqual(triggerIds.sort());
      },
    );
  });

  it("drops a queued stale date and catches up the postponed date once", async () => {
    await fixture([0], async ({ database, scheduler, planner, taskId }) => {
      expect(await scheduler.captureDue(time("2001-01-02T00:00:00Z"), 100)).toEqual({ created: 1 });
      const [old] = await dueEvents(database, taskId);
      if (!old) throw new Error("FIXTURE_EVENT_MISSING");
      await database
        .update(pacaTasks)
        .set({ dueDate: "2001-02-02" })
        .where(eq(pacaTasks.id, taskId));
      expect(await planner.plan(old.id)).toEqual([]);
      expect(await scheduler.captureDue(time("2001-01-03T00:00:00Z"), 100)).toEqual({ created: 0 });
      expect(await scheduler.captureDue(time("2001-02-04T00:00:00Z"), 100)).toEqual({ created: 1 });
      const next = (await dueEvents(database, taskId)).find((event) => event.id !== old.id);
      if (!next) throw new Error("FIXTURE_POSTPONED_EVENT_MISSING");
      const ids = await planner.plan(next.id);
      expect(ids).toHaveLength(1);
      expect(await scheduler.captureDue(time("2001-02-05T00:00:00Z"), 100)).toEqual({ created: 0 });
      // A persisted Run survives an uncertain Workflow start, even after graph/date edits.
      await database.update(pacaTasks).set({ dueDate: null }).where(eq(pacaTasks.id, taskId));
      expect(await planner.plan(next.id)).toEqual(ids);
      expect(await scheduler.captureDue(time("2001-02-05T00:00:00Z"), 100)).toEqual({ created: 0 });
    });
  });

  it("honors graph stop/edit, task deletion and project archive before planning", async () => {
    await fixture(
      [0],
      async ({ database, scheduler, planner, graph, projectId, automationId, taskId }) => {
        await scheduler.captureDue(time("2001-01-03T00:00:00Z"), 100);
        const [event] = await dueEvents(database, taskId);
        if (!event) throw new Error("FIXTURE_EVENT_MISSING");
        await graph.setActive(projectId, automationId, false);
        expect(await planner.plan(event.id)).toEqual([]);
        expect(await scheduler.captureDue(time("2001-01-03T00:00:00Z"), 100)).toEqual({
          created: 0,
        });
        await database
          .update(pacaAutomations)
          .set({ graphVersion: 2 })
          .where(eq(pacaAutomations.id, automationId));
        await graph.setActive(projectId, automationId, true);
        expect(await planner.plan(event.id)).toEqual([]);
        expect(await scheduler.captureDue(time("2001-01-03T00:00:00Z"), 100)).toEqual({
          created: 1,
        });
        const next = (await dueEvents(database, taskId)).find((row) => row.id !== event.id);
        if (!next) throw new Error("FIXTURE_VERSION_EVENT_MISSING");
        await database
          .update(pacaTasks)
          .set({ deletedAt: new Date() })
          .where(eq(pacaTasks.id, taskId));
        expect(await planner.plan(next.id)).toEqual([]);
        await database.update(pacaTasks).set({ deletedAt: null }).where(eq(pacaTasks.id, taskId));
        await database
          .update(pacaProjects)
          .set({ status: "archived" })
          .where(eq(pacaProjects.id, projectId));
        expect(await planner.plan(next.id)).toEqual([]);
        expect(await scheduler.captureDue(time("2001-01-03T00:00:00Z"), 100)).toEqual({
          created: 0,
        });
      },
    );
  });

  it("does not resurrect delivered events when producer bookkeeping arrives late", async () => {
    await fixture([0], async ({ database, scheduler, taskId }) => {
      await scheduler.captureDue(time("2001-01-03T00:00:00Z"), 100);
      const outbox = new PostgresAutomationOutboxRepository(database);
      const now = new Date();
      const claimed = await outbox.claim(now, 100);
      const due = claimed.find(
        (event) => event.taskId === taskId && event.eventType === "due_date_reached",
      );
      if (!due) throw new Error("FIXTURE_CLAIMED_EVENT_MISSING");
      await outbox.markDelivered(due.id, now);
      await outbox.markEnqueued([due.id], now);
      await outbox.release([due.id], now, "AUTOMATION_QUEUE_SEND_FAILED");
      expect(await outbox.get(due.id)).toMatchObject({ status: "delivered", failureCode: null });
      expect(await scheduler.captureDue(time("2001-01-03T00:00:00Z"), 100)).toEqual({ created: 0 });
    });
  });

  it("bounds catch-up batches and deduplicates concurrent scans on separate connections", async () => {
    await fixture([0], async ({ database, scheduler, taskId, projectId }) => {
      await database.insert(pacaTasks).values(
        [2, 3, 4].map((taskNumber) => ({
          projectId,
          taskNumber,
          title: "Catch up",
          dueDate: "2001-01-02",
        })),
      );
      const otherClient = new Client({ connectionString: databaseURL });
      await otherClient.connect();
      try {
        const other = new PostgresAutomationDueDateRepository(drizzle(otherClient, { schema }));
        const results = await Promise.all([
          scheduler.captureDue(time("2001-01-03T00:00:00Z"), 2),
          other.captureDue(time("2001-01-03T00:00:00Z"), 2),
        ]);
        expect(results.every((result) => result.created <= 2)).toBe(true);
        await scheduler.captureDue(time("2001-01-03T00:00:00Z"), 2);
        expect(await scheduler.captureDue(time("2001-01-03T00:00:00Z"), 2)).toEqual({ created: 0 });
        const events = await database
          .select()
          .from(pacaAutomationEventOutbox)
          .where(
            and(
              eq(pacaAutomationEventOutbox.projectId, projectId),
              eq(pacaAutomationEventOutbox.eventType, "due_date_reached"),
            ),
          );
        expect(events).toHaveLength(4);
        expect(new Set(events.map((event) => event.scheduleKey)).size).toBe(4);
        expect(events.filter((event) => event.taskId === taskId)).toHaveLength(1);
      } finally {
        await otherClient.end();
      }
    });
  });
});
