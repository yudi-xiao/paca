import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresAutomationRepository } from "../../src/automation/postgres-repository";
import * as schema from "../../src/db/schema";
import {
  organization,
  pacaAutomationEdges,
  pacaAutomationEventOutbox,
  pacaAutomationNodes,
  pacaAutomationRunSteps,
  pacaAutomationRuns,
  pacaAutomations,
  pacaProjects,
  pacaSprints,
  pacaTaskActivities,
  pacaTaskStatuses,
  pacaTasks,
  user,
} from "../../src/db/schema";
import { PostgresSprintAutomationRepository } from "../../src/iteration/postgres-automation";
import { PostgresIterationRepository } from "../../src/iteration/postgres-repository";

const url = process.env.PACA_TEST_DATABASE_URL?.trim();
if (process.env.PACA_REQUIRE_POSTGRES_CONTRACTS === "true" && !url)
  throw new Error("PACA_TEST_DATABASE_URL_REQUIRED");
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("FIXTURE_MISSING");
  return value;
}
async function fixture(run: (context: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const pool = new Pool({ connectionString: url, max: 4 });
  const db = drizzle(pool, { schema });
  const suffix = crypto.randomUUID();
  const userId = `sprint-action-${suffix}`;
  const orgId = `sprint-action-org-${suffix}`;
  try {
    await run(await setup(db, userId, orgId, suffix));
  } finally {
    try {
      await db.delete(organization).where(eq(organization.id, orgId));
      await db.delete(user).where(eq(user.id, userId));
    } finally {
      await pool.end();
    }
  }
}
async function setup(
  db: ReturnType<typeof drizzle<typeof schema>>,
  userId: string,
  orgId: string,
  suffix: string,
) {
  await db.insert(user).values({
    id: userId,
    name: "Sprint Actor",
    email: `${userId}@paca.test`,
    emailVerified: true,
  });
  await db
    .insert(organization)
    .values({ id: orgId, name: "Sprint Org", slug: orgId, createdAt: new Date() });
  const projects = await db
    .insert(pacaProjects)
    .values([
      { organizationId: orgId, name: "Sprint Actions", slug: `main-${suffix}`, createdBy: userId },
      { organizationId: orgId, name: "Other", slug: `other-${suffix}`, createdBy: userId },
    ])
    .returning();
  const project = required(projects[0]);
  const external = required(projects[1]);
  const sprints = await db
    .insert(pacaSprints)
    .values([
      {
        projectId: project.id,
        name: "Release",
        status: "active",
        startDate: "2026-10-01",
        endDate: "2026-10-20",
        goal: "Before",
      },
      { projectId: project.id, name: "Next" },
      { projectId: external.id, name: "External" },
    ])
    .returning();
  const sprint = required(sprints[0]);
  const destination = required(sprints[1]);
  const foreign = required(sprints[2]);
  const done = required(
    (
      await db
        .insert(pacaTaskStatuses)
        .values({ projectId: project.id, name: "Done", category: "done" })
        .returning()
    )[0],
  );
  const tasks = await db
    .insert(pacaTasks)
    .values([
      { projectId: project.id, taskNumber: 1, title: "Unfinished", sprintId: sprint.id },
      {
        projectId: project.id,
        taskNumber: 2,
        title: "Done",
        sprintId: sprint.id,
        statusId: done.id,
      },
      {
        projectId: project.id,
        taskNumber: 3,
        title: "Deleted",
        sprintId: sprint.id,
        deletedAt: new Date(),
      },
    ])
    .returning();
  const repository = new PostgresSprintAutomationRepository(db);
  const graph = new PostgresAutomationRepository(db);
  async function action(type: string, config: Record<string, unknown>, taskEvent = false) {
    const automation = required(
      (
        await db
          .insert(pacaAutomations)
          .values({ projectId: project.id, name: `Graph ${crypto.randomUUID()}` })
          .returning()
      )[0],
    );
    const trigger = required(
      (
        await db
          .insert(pacaAutomationNodes)
          .values({
            automationId: automation.id,
            kind: "trigger",
            type: taskEvent ? "task_created" : "sprint_started",
            config: taskEvent ? {} : { sprint_id: sprint.id },
          })
          .returning()
      )[0],
    );
    const node = required(
      (
        await db
          .insert(pacaAutomationNodes)
          .values({ automationId: automation.id, kind: "action", type, config })
          .returning()
      )[0],
    );
    await db
      .insert(pacaAutomationEdges)
      .values({ automationId: automation.id, sourceNodeId: trigger.id, targetNodeId: node.id });
    const snapshot = {
      version: 1,
      projectId: project.id,
      automationName: "Frozen name",
      event: {
        id: crypto.randomUUID(),
        type: trigger.type,
        taskId: taskEvent ? required(tasks[0]).id : null,
        payload: {},
        ...(!taskEvent
          ? {
              sprintSnapshot: {
                id: sprint.id,
                projectId: project.id,
                name: sprint.name,
                status: sprint.status,
                goal: sprint.goal,
                startDate: sprint.startDate,
                endDate: sprint.endDate,
              },
            }
          : {}),
      },
      nodes: [
        { id: trigger.id, kind: trigger.kind, type: trigger.type, config: trigger.config },
        { id: node.id, kind: node.kind, type: node.type, config: node.config },
      ],
      edges: [{ sourceNodeId: trigger.id, sourceHandle: null, targetNodeId: node.id }],
    };
    const persisted = required(
      (
        await db
          .insert(pacaAutomationRuns)
          .values({
            automationId: automation.id,
            triggerNodeId: trigger.id,
            graphVersion: 1,
            eventKey: crypto.randomUUID(),
            graphSnapshot: snapshot,
          })
          .returning()
      )[0],
    );
    return {
      projectId: project.id,
      runId: persisted.id,
      nodeId: node.id,
      sprintId: sprint.id,
      automationId: automation.id,
    };
  }
  return {
    db,
    userId,
    project,
    external,
    sprint,
    destination,
    foreign,
    tasks,
    repository,
    graph,
    action,
  };
}
(url ? describe : describe.skip)("PostgreSQL Sprint automation actions", () => {
  it("retains the user completion contract and writes the real user audit for backlog rollover", () =>
    fixture(async (c) => {
      const repository = new PostgresIterationRepository(c.db);
      const completed = await repository.completeSprint(c.project.id, c.sprint.id, null, c.userId);
      expect(completed.status).toBe("completed");
      const tasks = await c.db
        .select()
        .from(pacaTasks)
        .where(eq(pacaTasks.projectId, c.project.id));
      expect(tasks.find((task) => task.title === "Unfinished")?.sprintId).toBeNull();
      expect(tasks.find((task) => task.title === "Done")?.sprintId).toBe(c.sprint.id);
      const activities = await c.db
        .select()
        .from(pacaTaskActivities)
        .where(eq(pacaTaskActivities.projectId, c.project.id));
      expect(activities).toHaveLength(1);
      expect(activities[0]).toMatchObject({
        actorType: "user",
        actorId: c.userId,
        actorUserId: c.userId,
        actorAgentId: null,
      });
      expect(activities[0]?.content).not.toHaveProperty("automation_run_id");
      await expect(
        repository.completeSprint(c.project.id, c.sprint.id, null, c.userId),
      ).rejects.toThrow("SPRINT_ALREADY_COMPLETED");
    }));
  it("commits one rollover, system audit, event and step under concurrent delivery and late replay", () =>
    fixture(async (c) => {
      const action = await c.action("complete_sprint", { move_to_sprint_id: c.destination.id });
      const results = await Promise.all([c.repository.apply(action), c.repository.apply(action)]);
      expect(results[0]).toEqual(results[1]);
      expect(results[0]).toMatchObject({
        applied: true,
        moved_task_count: 1,
        sprint_id: c.sprint.id,
      });
      const tasks = await c.db
        .select()
        .from(pacaTasks)
        .where(eq(pacaTasks.projectId, c.project.id));
      expect(tasks.find((t) => t.title === "Unfinished")?.sprintId).toBe(c.destination.id);
      for (const title of ["Done", "Deleted"])
        expect(tasks.find((t) => t.title === title)?.sprintId).toBe(c.sprint.id);
      const activities = await c.db
        .select()
        .from(pacaTaskActivities)
        .where(eq(pacaTaskActivities.projectId, c.project.id));
      expect(activities).toHaveLength(1);
      expect(activities[0]).toMatchObject({
        actorType: "system",
        actorId: "system",
        content: { automation_run_id: action.runId },
      });
      const events = await c.db
        .select()
        .from(pacaAutomationEventOutbox)
        .where(
          and(
            eq(pacaAutomationEventOutbox.projectId, c.project.id),
            eq(pacaAutomationEventOutbox.eventType, "sprint_completed"),
          ),
        );
      expect(events).toHaveLength(1);
      expect(
        await c.db
          .select()
          .from(pacaAutomationRunSteps)
          .where(eq(pacaAutomationRunSteps.runId, action.runId)),
      ).toHaveLength(1);
      await c.db
        .update(pacaAutomationRuns)
        .set({ status: "completed" })
        .where(eq(pacaAutomationRuns.id, action.runId));
      expect(await c.repository.apply(action)).toEqual(results[0]);
      expect(await c.repository.apply(await c.action("complete_sprint", {}))).toMatchObject({
        applied: false,
        moved_task_count: 0,
      });
    }));
  it("uses the persisted graph and frozen target despite task reassignment and edited graph", () =>
    fixture(async (c) => {
      const action = await c.action(
        "update_sprint",
        {
          sprint_update: {
            name: "{{automation.name}}: {{sprint.name}}",
            goal: "{{task.title}}",
            start_date: null,
          },
        },
        true,
      );
      expect(await c.repository.resolveSprint(c.project.id, required(c.tasks[0]).id, null)).toBe(
        c.sprint.id,
      );
      await c.db
        .update(pacaTasks)
        .set({ sprintId: c.destination.id })
        .where(eq(pacaTasks.id, required(c.tasks[0]).id));
      await c.db
        .update(pacaAutomationNodes)
        .set({ config: { sprint_update: { name: "Changed graph" } } })
        .where(eq(pacaAutomationNodes.id, action.nodeId));
      await c.db
        .update(pacaAutomations)
        .set({ name: "Changed automation" })
        .where(eq(pacaAutomations.id, action.automationId));
      const result = await c.repository.apply(action);
      expect(result.changes).toContainEqual({
        field: "name",
        old: "Release",
        new: "Frozen name: Release",
      });
      expect(await c.repository.apply(action)).toEqual(result);
      const rows = await c.db
        .select()
        .from(pacaSprints)
        .where(eq(pacaSprints.projectId, c.project.id));
      expect(rows.find((s) => s.id === c.sprint.id)).toMatchObject({
        name: "Frozen name: Release",
        goal: "Unfinished",
        startDate: null,
      });
      expect(rows.find((s) => s.id === c.destination.id)?.name).toBe("Next");
      await expect(c.repository.apply({ ...action, sprintId: c.destination.id })).rejects.toThrow(
        "AUTOMATION_SPRINT_TARGET_INVALID",
      );
    }));
  it("revalidates current date ranges under the lock and rolls back without a completed step", () =>
    fixture(async (c) => {
      const action = await c.action("update_sprint", {
        sprint_update: { start_date: "2026-10-15", goal: "No partial write" },
      });
      await c.db
        .update(pacaSprints)
        .set({ endDate: "2026-10-10" })
        .where(eq(pacaSprints.id, c.sprint.id));
      await expect(c.repository.apply(action)).rejects.toThrow("SPRINT_DATE_INVALID");
      expect(
        required((await c.db.select().from(pacaSprints).where(eq(pacaSprints.id, c.sprint.id)))[0])
          .goal,
      ).toBe("Before");
      expect(
        await c.db
          .select()
          .from(pacaAutomationRunSteps)
          .where(eq(pacaAutomationRunSteps.runId, action.runId)),
      ).toHaveLength(0);
    }));
  it("rejects cross-project targets, unknown nodes, missing contexts and archived projects", () =>
    fixture(async (c) => {
      await expect(c.repository.resolveSprint(c.project.id, null, null)).rejects.toThrow(
        "AUTOMATION_SPRINT_CONTEXT_MISSING",
      );
      await expect(c.repository.resolveSprint(c.project.id, null, c.foreign.id)).rejects.toThrow(
        "SPRINT_NOT_FOUND",
      );
      const action = await c.action("complete_sprint", { move_to_sprint_id: c.foreign.id });
      await expect(c.graph.setActive(c.project.id, action.automationId, true)).rejects.toThrow(
        "AUTOMATION_SPRINT_DESTINATION_INVALID",
      );
      await expect(c.repository.apply(action)).rejects.toThrow("SPRINT_DESTINATION_INVALID");
      await expect(c.repository.apply({ ...action, projectId: c.external.id })).rejects.toThrow(
        "AUTOMATION_RUN_NOT_FOUND",
      );
      await expect(c.repository.apply({ ...action, nodeId: crypto.randomUUID() })).rejects.toThrow(
        "AUTOMATION_SPRINT_NODE_INVALID",
      );
      await expect(c.repository.apply({ ...action, sprintId: c.foreign.id })).rejects.toThrow(
        "AUTOMATION_SPRINT_TARGET_INVALID",
      );
      await c.db
        .update(pacaProjects)
        .set({ status: "archived" })
        .where(eq(pacaProjects.id, c.project.id));
      await expect(c.repository.apply(action)).rejects.toThrow("AUTOMATION_PROJECT_NOT_FOUND");
      expect(
        required((await c.db.select().from(pacaSprints).where(eq(pacaSprints.id, c.sprint.id)))[0])
          .status,
      ).toBe("active");
    }));
  it("rechecks a completed or self destination at execution after activation", () =>
    fixture(async (c) => {
      const action = await c.action("complete_sprint", { move_to_sprint_id: c.destination.id });
      await c.graph.setActive(c.project.id, action.automationId, true);
      await c.db
        .update(pacaSprints)
        .set({ status: "completed" })
        .where(eq(pacaSprints.id, c.destination.id));
      await expect(c.repository.apply(action)).rejects.toThrow("SPRINT_DESTINATION_INVALID");
      await expect(
        c.repository.apply(await c.action("complete_sprint", { move_to_sprint_id: c.sprint.id })),
      ).rejects.toThrow("SPRINT_DESTINATION_INVALID");
    }));
});
