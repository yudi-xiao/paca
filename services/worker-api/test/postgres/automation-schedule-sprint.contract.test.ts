import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresAutomationCronRepository } from "../../src/automation/cron-scheduler";
import { PostgresAutomationConditionReader } from "../../src/automation/postgres-condition-reader";
import { PostgresAutomationRepository } from "../../src/automation/postgres-repository";
import { PostgresAutomationTargetReader } from "../../src/automation/postgres-target-reader";
import { PostgresAutomationRunPlanner } from "../../src/automation/run-planner";
import { automationRunSnapshotSchema } from "../../src/automation/run-protocol";
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
  pacaSprints,
  pacaTasks,
  user,
} from "../../src/db/schema";

const databaseURL = process.env.PACA_TEST_DATABASE_URL?.trim();
if (process.env.PACA_REQUIRE_POSTGRES_CONTRACTS === "true" && !databaseURL)
  throw new Error("PACA_TEST_DATABASE_URL_REQUIRED");
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("FIXTURE_VALUE_MISSING");
  return value;
}

type Context = {
  client: Client;
  database: PacaDatabase;
  projectId: string;
  externalProjectId: string;
  taskId: string;
  externalTaskId: string;
  graph: PostgresAutomationRepository;
  scheduler: PostgresAutomationCronRepository;
  planner: PostgresAutomationRunPlanner;
};
async function fixture(run: (context: Context) => Promise<void>) {
  const client = new Client({ connectionString: databaseURL });
  await client.connect();
  const database = drizzle(client, { schema });
  const suffix = crypto.randomUUID();
  const userId = `schedule-${suffix}`;
  const organizationId = `schedule-org-${suffix}`;
  try {
    await database
      .insert(user)
      .values({ id: userId, name: "Scheduler", email: `${userId}@paca.test`, emailVerified: true });
    await database.insert(organization).values({
      id: organizationId,
      name: "Scheduler",
      slug: organizationId,
      createdAt: new Date(),
    });
    const [project, external] = await database
      .insert(pacaProjects)
      .values([
        { organizationId, name: "Scheduler", slug: `main-${suffix}`, createdBy: userId },
        { organizationId, name: "External", slug: `external-${suffix}`, createdBy: userId },
      ])
      .returning();
    if (!project || !external) throw new Error("FIXTURE_PROJECT_MISSING");
    const [task, externalTask] = await database
      .insert(pacaTasks)
      .values([
        { projectId: project.id, taskNumber: 1, title: "Release", tags: ["release"] },
        { projectId: external.id, taskNumber: 1, title: "External" },
      ])
      .returning();
    if (!task || !externalTask) throw new Error("FIXTURE_TASK_MISSING");
    await run({
      client,
      database,
      projectId: project.id,
      externalProjectId: external.id,
      taskId: task.id,
      externalTaskId: externalTask.id,
      graph: new PostgresAutomationRepository(database),
      scheduler: new PostgresAutomationCronRepository(database),
      planner: new PostgresAutomationRunPlanner(database),
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
async function createGraph(
  context: Context,
  triggers: { type: string; config: Record<string, unknown> }[],
  action = { type: "wait", config: { wait_minutes: 1 } as Record<string, unknown> },
) {
  const [automation] = await context.database
    .insert(pacaAutomations)
    .values({ projectId: context.projectId, name: `Schedule ${crypto.randomUUID()}` })
    .returning();
  if (!automation) throw new Error("FIXTURE_GRAPH_MISSING");
  const nodes = await context.database
    .insert(pacaAutomationNodes)
    .values(
      triggers.map((trigger) => ({
        automationId: automation.id,
        kind: "trigger" as const,
        ...trigger,
      })),
    )
    .returning();
  const [target] = await context.database
    .insert(pacaAutomationNodes)
    .values({ automationId: automation.id, kind: "action", ...action })
    .returning();
  if (!target) throw new Error("FIXTURE_ACTION_MISSING");
  await context.database.insert(pacaAutomationEdges).values(
    nodes.map((node) => ({
      automationId: automation.id,
      sourceNodeId: node.id,
      targetNodeId: target.id,
    })),
  );
  return { automationId: automation.id, nodes };
}
async function events(context: Context, type: string) {
  return context.database
    .select()
    .from(pacaAutomationEventOutbox)
    .where(
      and(
        eq(pacaAutomationEventOutbox.projectId, context.projectId),
        eq(pacaAutomationEventOutbox.eventType, type),
      ),
    );
}
async function cursor(context: Context, id: string) {
  const [node] = await context.database
    .select()
    .from(pacaAutomationNodes)
    .where(eq(pacaAutomationNodes.id, id));
  return node?.nextScheduledAt;
}
const historical = new Date("2001-01-01T00:15:00Z");

(databaseURL ? describe : describe.skip)("PostgreSQL Cron and Sprint Automation", () => {
  it("initializes from activation, captures UTC minutes once per node and collapses missed times", async () =>
    fixture(async (context) => {
      const graph = await createGraph(context, [
        { type: "cron", config: { cron_expression: "*/15 * * * *" } },
        {
          type: "cron",
          config: { cron_expression: "*/15 * * * *", target_task_id: context.taskId },
        },
      ]);
      const activated = await context.graph.setActive(context.projectId, graph.automationId, true);
      expect(
        required(await cursor(context, required(graph.nodes[0]).id)).getTime(),
      ).toBeGreaterThan(activated.updatedAt.getTime());
      expect(await context.scheduler.captureDue(activated.updatedAt, 100)).toEqual({ created: 0 });
      await context.database
        .update(pacaAutomationNodes)
        .set({ nextScheduledAt: historical })
        .where(eq(pacaAutomationNodes.automationId, graph.automationId));
      await context.client.query("SET TIME ZONE 'Pacific/Honolulu'");
      expect(await context.scheduler.captureDue(new Date("2001-01-01T00:14:59Z"), 100)).toEqual({
        created: 0,
      });
      expect(await context.scheduler.captureDue(historical, 1)).toEqual({ created: 1 });
      expect(await context.scheduler.captureDue(historical, 100)).toEqual({ created: 1 });
      expect(await context.scheduler.captureDue(historical, 100)).toEqual({ created: 0 });
      expect(await context.scheduler.captureDue(new Date("2001-01-01T03:46:00Z"), 100)).toEqual({
        created: 2,
      });
      const rows = await events(context, "cron");
      expect(rows).toHaveLength(4);
      expect(
        rows.filter((row) => row.payload.scheduled_for === "2001-01-01T03:45:00.000Z"),
      ).toHaveLength(2);
      expect(await cursor(context, required(graph.nodes[0]).id)).toEqual(
        new Date("2001-01-01T04:00:00Z"),
      );
      for (const row of rows) {
        const ids = await context.planner.plan(row.id);
        expect(ids).toHaveLength(1);
        expect(await context.planner.plan(row.id)).toEqual(ids);
        const [run] = await context.database
          .select()
          .from(pacaAutomationRuns)
          .where(eq(pacaAutomationRuns.id, required(ids[0])));
        const snapshot = automationRunSnapshotSchema.parse(run?.graphSnapshot);
        expect(snapshot.event.taskId).toBe(row.taskId);
      }
    }));
  it("rolls back both event and cursor on failure and serializes concurrent scanners", async () =>
    fixture(async (context) => {
      const graph = await createGraph(context, [
        { type: "cron", config: { cron_expression: "*/15 * * * *" } },
      ]);
      await context.graph.setActive(context.projectId, graph.automationId, true);
      await context.database
        .update(pacaAutomationNodes)
        .set({ nextScheduledAt: historical })
        .where(eq(pacaAutomationNodes.automationId, graph.automationId));
      const functionName = `paca_test_cron_${crypto.randomUUID().replaceAll("-", "")}`;
      await context.client.query(
        `CREATE FUNCTION ${functionName}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'TEST_CRON_FAILURE'; END $$ LANGUAGE plpgsql`,
      );
      await context.client.query(
        `CREATE TRIGGER ${functionName} BEFORE INSERT ON paca_automation_event_outbox FOR EACH ROW WHEN (NEW.project_id = '${context.projectId}' AND NEW.event_type = 'cron') EXECUTE FUNCTION ${functionName}()`,
      );
      try {
        await expect(context.scheduler.captureDue(historical, 100)).rejects.toThrow();
        expect(await events(context, "cron")).toHaveLength(0);
        expect(await cursor(context, required(graph.nodes[0]).id)).toEqual(historical);
      } finally {
        await context.client.query(`DROP TRIGGER ${functionName} ON paca_automation_event_outbox`);
        await context.client.query(`DROP FUNCTION ${functionName}()`);
      }
      const other = new Client({ connectionString: databaseURL });
      await other.connect();
      try {
        const results = await Promise.all([
          context.scheduler.captureDue(historical, 100),
          new PostgresAutomationCronRepository(drizzle(other, { schema })).captureDue(
            historical,
            100,
          ),
        ]);
        expect(results.reduce((sum, result) => sum + result.created, 0)).toBe(1);
        expect(await events(context, "cron")).toHaveLength(1);
      } finally {
        await other.end();
      }
    }));
  it("rejects missing task context and foreign targets, and stops stale events after deactivation", async () =>
    fixture(async (context) => {
      const invalid = await createGraph(
        context,
        [{ type: "cron", config: { cron_expression: "* * * * *" } }],
        { type: "update_task", config: { update: { tags: ["unsafe"] } } },
      );
      await expect(
        context.graph.setActive(context.projectId, invalid.automationId, true),
      ).rejects.toThrow("AUTOMATION_EDGE_REQUIRES_TARGET_TASK");
      const foreign = await createGraph(context, [
        {
          type: "cron",
          config: { cron_expression: "* * * * *", target_task_id: context.externalTaskId },
        },
      ]);
      await expect(
        context.graph.setActive(context.projectId, foreign.automationId, true),
      ).rejects.toThrow("AUTOMATION_TRIGGER_TASK_NOT_FOUND");
      const valid = await createGraph(
        context,
        [{ type: "cron", config: { cron_expression: "*/15 * * * *" } }],
        {
          type: "update_task",
          config: {
            update: { tags: ["release"] },
            target: { kind: "other", other_task_id: context.taskId },
          },
        },
      );
      await context.graph.setActive(context.projectId, valid.automationId, true);
      await context.database
        .update(pacaAutomationNodes)
        .set({ nextScheduledAt: historical })
        .where(eq(pacaAutomationNodes.automationId, valid.automationId));
      await context.scheduler.captureDue(historical, 100);
      const [event] = await events(context, "cron");
      if (!event) throw new Error("FIXTURE_EVENT_MISSING");
      await context.graph.setActive(context.projectId, valid.automationId, false);
      expect(await cursor(context, required(valid.nodes[0]).id)).toBeNull();
      expect(await context.planner.plan(event.id)).toEqual([]);
      expect(await context.scheduler.captureDue(historical, 100)).toEqual({ created: 0 });
      await context.graph.setActive(context.projectId, valid.automationId, true);
      expect(await context.planner.plan(event.id)).toEqual([]);
    }));
  it("captures lifecycle transitions atomically, filters Sprints and preserves deleted snapshots", async () =>
    fixture(async (context) => {
      const graph = await createGraph(
        context,
        ["sprint_created", "sprint_started", "sprint_completed", "sprint_deleted"].map((type) => ({
          type,
          config: {},
        })),
      );
      await context.graph.setActive(context.projectId, graph.automationId, true);
      const [sprint] = await context.database
        .insert(pacaSprints)
        .values({
          projectId: context.projectId,
          name: "Release",
          goal: "Ship",
          startDate: "2001-01-01",
          endDate: "2001-01-07",
        })
        .returning();
      if (!sprint) throw new Error("FIXTURE_SPRINT_MISSING");
      const filtered = await createGraph(context, [
        { type: "sprint_started", config: { sprint_id: sprint.id } },
      ]);
      await context.graph.setActive(context.projectId, filtered.automationId, true);
      await context.database
        .update(pacaSprints)
        .set({ name: "Release 1" })
        .where(eq(pacaSprints.id, sprint.id));
      await expect(
        context.database.transaction(async (tx) => {
          await tx
            .update(pacaSprints)
            .set({ status: "active" })
            .where(eq(pacaSprints.id, sprint.id));
          throw new Error("ROLLBACK");
        }),
      ).rejects.toThrow("ROLLBACK");
      expect(await events(context, "sprint_started")).toHaveLength(0);
      await context.database
        .update(pacaSprints)
        .set({ status: "active" })
        .where(eq(pacaSprints.id, sprint.id));
      await context.database
        .update(pacaSprints)
        .set({ status: "active" })
        .where(eq(pacaSprints.id, sprint.id));
      const [started] = await events(context, "sprint_started");
      if (!started) throw new Error("FIXTURE_EVENT_MISSING");
      expect(await events(context, "sprint_started")).toHaveLength(1);
      expect(await context.planner.plan(started.id)).toHaveLength(2);
      const [other] = await context.database
        .insert(pacaSprints)
        .values({ projectId: context.projectId, name: "Other" })
        .returning();
      if (!other) throw new Error("FIXTURE_SPRINT_MISSING");
      await context.database
        .update(pacaSprints)
        .set({ status: "active" })
        .where(eq(pacaSprints.id, other.id));
      const otherEvent = (await events(context, "sprint_started")).find(
        (row) => row.payload.sprint_id === other.id,
      );
      expect(await context.planner.plan(required(otherEvent).id)).toHaveLength(1);
      await context.database
        .update(pacaSprints)
        .set({ status: "completed" })
        .where(eq(pacaSprints.id, sprint.id));
      await context.database.delete(pacaSprints).where(eq(pacaSprints.id, sprint.id));
      const [deleted] = await events(context, "sprint_deleted");
      if (!deleted) throw new Error("FIXTURE_EVENT_MISSING");
      expect(deleted.payload.sprint).toMatchObject({
        id: sprint.id,
        name: "Release 1",
        status: "completed",
        startDate: "2001-01-01",
        endDate: "2001-01-07",
      });
      const ids = await context.planner.plan(deleted.id);
      expect(ids).toHaveLength(1);
      const [run] = await context.database
        .select()
        .from(pacaAutomationRuns)
        .where(eq(pacaAutomationRuns.id, required(ids[0])));
      const snapshot = automationRunSnapshotSchema.parse(run?.graphSnapshot);
      expect(snapshot.event.taskId).toBeNull();
      expect(snapshot.event.sprintSnapshot).toEqual(deleted.payload.sprint);
      const reader = new PostgresAutomationConditionReader(context.database);
      const node = {
        id: crypto.randomUUID(),
        kind: "condition" as const,
        type: "condition",
        config: {
          branches: [
            {
              handle: "matched",
              tree: { field: "sprint_goal", operator: "equals", value: "Ship" },
            },
          ],
        },
      };
      expect(
        await reader.selectHandle(
          context.projectId,
          null,
          node,
          snapshot.event.sprintSnapshot,
          true,
        ),
      ).toBe("matched");
      expect(
        await reader.selectHandle(
          context.projectId,
          null,
          node,
          snapshot.event.sprintSnapshot,
          false,
        ),
      ).toBe("else");
      await context.database
        .update(pacaProjects)
        .set({ status: "archived" })
        .where(eq(pacaProjects.id, context.projectId));
      await context.database.delete(pacaSprints).where(eq(pacaSprints.id, other.id));
      expect(await events(context, "sprint_deleted")).toHaveLength(1);
    }));
  it("reads live Sprint conditions and explicit task targets without inventing a base task", async () =>
    fixture(async (context) => {
      const [sprint] = await context.database
        .insert(pacaSprints)
        .values({ projectId: context.projectId, name: "Live", status: "active" })
        .returning();
      if (!sprint) throw new Error("FIXTURE_SPRINT_MISSING");
      const reader = new PostgresAutomationConditionReader(context.database);
      const snapshot = {
        id: sprint.id,
        projectId: context.projectId,
        name: "Stale",
        status: "planned" as const,
        goal: null,
        startDate: null,
        endDate: null,
      };
      const node = (tree: Record<string, unknown>) => ({
        id: crypto.randomUUID(),
        kind: "condition" as const,
        type: "condition",
        config: { branches: [{ handle: "yes", tree }] },
      });
      expect(
        await reader.selectHandle(
          context.projectId,
          null,
          node({ field: "sprint_name", operator: "equals", value: "Live" }),
          snapshot,
        ),
      ).toBe("yes");
      expect(
        await reader.selectHandle(
          context.projectId,
          null,
          node({
            field: "tags",
            operator: "contains",
            value: "release",
            target: { kind: "other", other_task_id: context.taskId },
          }),
        ),
      ).toBe("yes");
      expect(
        await reader.selectHandle(
          context.projectId,
          null,
          node({
            field: "title",
            operator: "equals",
            value: "External",
            target: { kind: "other", other_task_id: context.externalTaskId },
          }),
        ),
      ).toBe("else");
      await expect(
        reader.selectHandle(
          context.externalProjectId,
          null,
          node({ field: "sprint_name", operator: "equals", value: "Live" }),
          snapshot,
        ),
      ).rejects.toThrow("AUTOMATION_SPRINT_NOT_FOUND");
      const targets = new PostgresAutomationTargetReader(context.database);
      expect(
        await targets.resolveTaskIds(context.projectId, null, {
          kind: "other",
          other_task_id: context.taskId,
        }),
      ).toEqual([context.taskId]);
      await expect(
        targets.resolveTaskIds(context.projectId, null, {
          kind: "other",
          other_task_id: context.externalTaskId,
        }),
      ).rejects.toThrow("AUTOMATION_TARGET_NOT_FOUND");
      await expect(
        targets.resolveTaskIds(context.projectId, null, { kind: "self" }),
      ).rejects.toThrow("AUTOMATION_EDGE_REQUIRES_TARGET_TASK");
      const foreign = await context.database
        .insert(pacaSprints)
        .values({ projectId: context.externalProjectId, name: "External" })
        .returning();
      const graph = await createGraph(context, [
        { type: "sprint_started", config: { sprint_id: required(foreign[0]).id } },
      ]);
      await expect(
        context.graph.setActive(context.projectId, graph.automationId, true),
      ).rejects.toThrow("AUTOMATION_TRIGGER_SPRINT_NOT_FOUND");
    }));
});
