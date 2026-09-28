import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { type AutomationGraphError, automationGraphErrorCodes } from "../../src/automation/graph";
import {
  type AutomationRepositoryError,
  automationRepositoryErrorCodes,
  PostgresAutomationRepository,
} from "../../src/automation/postgres-repository";
import * as schema from "../../src/db/schema";
import {
  organization,
  pacaAutomationEdges,
  pacaAutomationNodes,
  pacaAutomationRunSteps,
  pacaAutomationRuns,
  pacaAutomations,
  pacaProjects,
  user,
} from "../../src/db/schema";

const databaseURL = process.env.PACA_TEST_DATABASE_URL?.trim();
if (process.env.PACA_REQUIRE_POSTGRES_CONTRACTS === "true" && !databaseURL) {
  throw new Error("PACA_TEST_DATABASE_URL_REQUIRED");
}

(databaseURL ? describe : describe.skip)("PostgreSQL Automation graph schema", () => {
  it("isolates project graphs and preserves idempotent run history", async () => {
    if (!databaseURL) throw new Error("PACA_TEST_DATABASE_URL_REQUIRED");
    const client = new Client({
      connectionString: databaseURL,
      connectionTimeoutMillis: 5_000,
      query_timeout: 5_000,
      statement_timeout: 5_000,
    });
    await client.connect();
    const database = drizzle(client, { schema });
    const suffix = crypto.randomUUID();
    const actorId = `automation-contract-${suffix}`;
    const organizationId = `automation-org-${suffix}`;

    try {
      await database.insert(user).values({
        id: actorId,
        name: "Automation Contract User",
        email: `${actorId}@paca.test`,
        emailVerified: true,
      });
      await database.insert(organization).values({
        id: organizationId,
        name: "Automation Contract Organization",
        slug: organizationId,
        createdAt: new Date(),
      });
      const [projectA, projectB] = await database
        .insert(pacaProjects)
        .values([
          { organizationId, name: "Automation A", slug: `a-${suffix}`, createdBy: actorId },
          { organizationId, name: "Automation B", slug: `b-${suffix}`, createdBy: actorId },
        ])
        .returning();
      if (!projectA || !projectB) throw new Error("AUTOMATION_TEST_PROJECT_INSERT_FAILED");
      const [automationA, automationB] = await database
        .insert(pacaAutomations)
        .values([
          { projectId: projectA.id, name: "Review", createdBy: actorId },
          { projectId: projectB.id, name: "Review", createdBy: actorId },
        ])
        .returning();
      if (!automationA || !automationB) throw new Error("AUTOMATION_TEST_INSERT_FAILED");
      const repository = new PostgresAutomationRepository(database);
      expect((await repository.list(projectA.id)).map((item) => item.id)).toEqual([automationA.id]);
      await expect(repository.getGraph(projectB.id, automationA.id)).rejects.toMatchObject({
        code: automationRepositoryErrorCodes.notFound,
      } satisfies Partial<AutomationRepositoryError>);
      expect(automationA.status).toBe("inactive");
      expect(automationA.graphVersion).toBe(1);

      const [triggerA, actionA, actionB] = await database
        .insert(pacaAutomationNodes)
        .values([
          { automationId: automationA.id, kind: "trigger", type: "task_created" },
          { automationId: automationA.id, kind: "action", type: "update_task" },
          { automationId: automationB.id, kind: "action", type: "update_task" },
        ])
        .returning();
      if (!triggerA || !actionA || !actionB) throw new Error("AUTOMATION_TEST_NODE_INSERT_FAILED");

      const [edge] = await database
        .insert(pacaAutomationEdges)
        .values({
          automationId: automationA.id,
          sourceNodeId: triggerA.id,
          targetNodeId: actionA.id,
        })
        .returning();
      if (!edge) throw new Error("AUTOMATION_TEST_EDGE_INSERT_FAILED");
      expect(edge.automationId).toBe(automationA.id);
      await expect(
        repository.addEdge(projectA.id, automationA.id, {
          sourceNodeId: actionA.id,
          targetNodeId: actionB.id,
        }),
      ).rejects.toMatchObject({
        code: automationGraphErrorCodes.edgeCrossAutomation,
      } satisfies Partial<AutomationGraphError>);

      const extraAction = await repository.addNode(projectA.id, automationA.id, {
        kind: "action",
        type: "update_task",
        config: {},
        posX: 12,
        posY: 24,
      });
      const nextEdge = await repository.addEdge(projectA.id, automationA.id, {
        sourceNodeId: actionA.id,
        targetNodeId: extraAction.id,
      });
      expect(nextEdge.sourceNodeId).toBe(actionA.id);
      await expect(
        repository.addEdge(projectA.id, automationA.id, {
          sourceNodeId: extraAction.id,
          targetNodeId: actionA.id,
        }),
      ).rejects.toMatchObject({
        code: automationGraphErrorCodes.edgeCycle,
      } satisfies Partial<AutomationGraphError>);
      expect((await repository.getGraph(projectA.id, automationA.id)).automation.graphVersion).toBe(
        3,
      );

      await expect(
        client.query(
          "insert into paca_automation_edge (automation_id, source_node_id, target_node_id) values ($1, $2, $3)",
          [automationA.id, triggerA.id, actionB.id],
        ),
      ).rejects.toMatchObject({ code: "23503" });
      await expect(
        client.query("insert into paca_automation (project_id, name) values ($1, $2)", [
          projectA.id,
          "review",
        ]),
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        client.query(
          "insert into paca_automation_edge (automation_id, source_node_id, target_node_id) values ($1, $2, $3)",
          [automationA.id, triggerA.id, actionA.id],
        ),
      ).rejects.toMatchObject({ code: "23505" });

      const [run] = await database
        .insert(pacaAutomationRuns)
        .values({
          automationId: automationA.id,
          triggerNodeId: triggerA.id,
          eventKey: `task-created:${suffix}`,
          graphVersion: automationA.graphVersion,
          graphSnapshot: { nodes: [triggerA.id, actionA.id], edges: [edge.id] },
        })
        .returning();
      if (!run) throw new Error("AUTOMATION_TEST_RUN_INSERT_FAILED");
      await database.insert(pacaAutomationRunSteps).values({
        runId: run.id,
        nodeId: actionA.id,
        stepKey: "action-1",
        status: "completed",
      });
      expect(
        (await repository.listRuns(projectA.id, automationA.id, 10)).map((item) => item.id),
      ).toEqual([run.id]);
      expect(await repository.listRuns(projectA.id, automationA.id, 1)).toHaveLength(1);
      expect(await repository.listRunSteps(projectA.id, automationA.id, run.id)).toHaveLength(1);
      await expect(repository.listRuns(projectB.id, automationA.id, 10)).rejects.toMatchObject({
        code: automationRepositoryErrorCodes.notFound,
      });
      await expect(
        repository.listRunSteps(projectB.id, automationA.id, run.id),
      ).rejects.toMatchObject({ code: automationRepositoryErrorCodes.notFound });
      await expect(
        repository.listRunSteps(projectA.id, automationA.id, crypto.randomUUID()),
      ).rejects.toMatchObject({ code: automationRepositoryErrorCodes.notFound });
      await expect(
        client.query(
          "insert into paca_automation_run (automation_id, trigger_node_id, event_key, graph_version, graph_snapshot) values ($1, $2, $3, 1, '{}')",
          [automationA.id, triggerA.id, `task-created:${suffix}`],
        ),
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        client.query(
          "insert into paca_automation_run_step (run_id, node_id, step_key, status) values ($1, $2, 'action-1', 'completed')",
          [run.id, actionA.id],
        ),
      ).rejects.toMatchObject({ code: "23505" });

      await database.delete(pacaAutomationNodes).where(eq(pacaAutomationNodes.id, actionA.id));
      expect(
        await database
          .select()
          .from(pacaAutomationEdges)
          .where(eq(pacaAutomationEdges.id, edge.id)),
      ).toEqual([]);
      expect(
        await database
          .select()
          .from(pacaAutomationRunSteps)
          .where(eq(pacaAutomationRunSteps.runId, run.id)),
      ).toHaveLength(1);
    } finally {
      try {
        await database.delete(organization).where(eq(organization.id, organizationId));
        await database.delete(user).where(eq(user.id, actorId));
      } finally {
        await client.end();
      }
    }
  });
});
