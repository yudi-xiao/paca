import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app";
import type { AppBindings } from "../../src/bindings";
import * as schema from "../../src/db/schema";
import { organization, pacaProjects, user } from "../../src/db/schema";

const databaseURL = process.env.PACA_TEST_DATABASE_URL?.trim();
if (process.env.PACA_REQUIRE_POSTGRES_CONTRACTS === "true" && !databaseURL) {
  throw new Error("PACA_TEST_DATABASE_URL_REQUIRED");
}

(databaseURL ? describe : describe.skip)("PostgreSQL Automation HTTP contract", () => {
  it("creates and edits an isolated inactive graph through the authenticated Worker routes", async () => {
    if (!databaseURL) throw new Error("PACA_TEST_DATABASE_URL_REQUIRED");
    const client = new Client({ connectionString: databaseURL });
    await client.connect();
    const database = drizzle(client, { schema });
    const suffix = crypto.randomUUID();
    const actorId = `automation-http-${suffix}`;
    const organizationId = `automation-http-org-${suffix}`;
    const env = {
      ENVIRONMENT: "test",
      HYPERDRIVE: { connectionString: databaseURL },
    } as AppBindings;

    try {
      await database.insert(user).values({
        id: actorId,
        name: "Automation HTTP User",
        email: `${actorId}@paca.test`,
        emailVerified: true,
      });
      await database.insert(organization).values({
        id: organizationId,
        name: "Automation HTTP Org",
        slug: organizationId,
        createdAt: new Date(),
      });
      const [projectA, projectB] = await database
        .insert(pacaProjects)
        .values([
          { organizationId, name: "Automation HTTP A", slug: `a-${suffix}`, createdBy: actorId },
          { organizationId, name: "Automation HTTP B", slug: `b-${suffix}`, createdBy: actorId },
        ])
        .returning();
      if (!projectA || !projectB) throw new Error("AUTOMATION_HTTP_PROJECT_INSERT_FAILED");

      const authorizeProjectPermission = vi.fn(async () => ({
        authenticated: true as const,
        userId: actorId,
        decision: {
          scopeExists: true,
          allowed: true,
          grants: [{ resource: "workflows" as const, action: "*" }],
        },
      }));
      const app = createApp({ authorizeProjectPermission, log: vi.fn() });
      const base = `/api/v1/projects/${projectA.id}/automations`;
      const request = (path: string, method: string, body?: unknown) =>
        app.request(
          path,
          {
            method,
            headers: body === undefined ? undefined : { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          },
          env,
        );

      const createdResponse = await request(base, "POST", { name: "Review tasks" });
      expect(createdResponse.status).toBe(201);
      const created = (await createdResponse.json()) as { data: { id: string; status: string } };
      expect(created.data.status).toBe("inactive");

      const triggerResponse = await request(`${base}/${created.data.id}/nodes`, "POST", {
        kind: "trigger",
        type: "task_created",
        config: {},
        pos_x: 0,
        pos_y: 0,
      });
      const actionResponse = await request(`${base}/${created.data.id}/nodes`, "POST", {
        kind: "action",
        type: "update_task",
        config: { update: { importance: 1 } },
        pos_x: 200,
        pos_y: 0,
      });
      expect(triggerResponse.status).toBe(201);
      expect(actionResponse.status).toBe(201);
      const trigger = (await triggerResponse.json()) as { data: { id: string } };
      const action = (await actionResponse.json()) as { data: { id: string } };

      const edgeResponse = await request(`${base}/${created.data.id}/edges`, "POST", {
        source_node_id: trigger.data.id,
        target_node_id: action.data.id,
      });
      expect(edgeResponse.status).toBe(201);
      const graphResponse = await request(`${base}/${created.data.id}`, "GET");
      expect(graphResponse.status).toBe(200);
      await expect(graphResponse.json()).resolves.toMatchObject({
        success: true,
        data: {
          automation: { id: created.data.id, project_id: projectA.id, status: "inactive" },
          nodes: [{ id: trigger.data.id }, { id: action.data.id }],
          edges: [{ source_node_id: trigger.data.id, target_node_id: action.data.id }],
        },
      });

      const activated = await request(`${base}/${created.data.id}/activate`, "POST");
      expect(activated.status).toBe(200);
      await expect(activated.json()).resolves.toMatchObject({
        data: { id: created.data.id, status: "active" },
      });
      const editWhileActive = await request(
        `${base}/${created.data.id}/nodes/${action.data.id}`,
        "PATCH",
        { config: { update: { importance: 2 } } },
      );
      expect(editWhileActive.status).toBe(409);
      await expect(editWhileActive.json()).resolves.toMatchObject({
        error_code: "AUTOMATION_ACTIVE_GRAPH_IMMUTABLE",
      });
      const archiveWhileActive = await request(`${base}/${created.data.id}`, "DELETE");
      expect(archiveWhileActive.status).toBe(409);
      await expect(archiveWhileActive.json()).resolves.toMatchObject({
        error_code: "AUTOMATION_ACTIVE_GRAPH_IMMUTABLE",
      });
      const crossProjectActivation = await request(
        `/api/v1/projects/${projectB.id}/automations/${created.data.id}/activate`,
        "POST",
      );
      expect(crossProjectActivation.status).toBe(404);

      const deactivated = await request(`${base}/${created.data.id}/deactivate`, "POST");
      expect(deactivated.status).toBe(200);
      await expect(deactivated.json()).resolves.toMatchObject({
        data: { id: created.data.id, status: "inactive" },
      });
      const unsupportedUpdate = await request(
        `${base}/${created.data.id}/nodes/${action.data.id}`,
        "PATCH",
        { config: { update: { assignee_ids: [] } } },
      );
      expect(unsupportedUpdate.status).toBe(200);
      const rejectedActivation = await request(`${base}/${created.data.id}/activate`, "POST");
      expect(rejectedActivation.status).toBe(400);
      await expect(rejectedActivation.json()).resolves.toMatchObject({
        error_code: "AUTOMATION_UPDATE_TASK_CONFIG_INVALID",
      });

      const otherProject = await request(
        `/api/v1/projects/${projectB.id}/automations/${created.data.id}`,
        "GET",
      );
      expect(otherProject.status).toBe(404);
      expect(authorizeProjectPermission).toHaveBeenCalledWith(
        expect.any(Request),
        env,
        projectA.id,
        { workflows: ["write"] },
      );
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
