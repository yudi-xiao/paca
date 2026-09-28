import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

import { PostgresAutomationConditionReader } from "../../src/automation/postgres-condition-reader";
import { PostgresAutomationTargetReader } from "../../src/automation/postgres-target-reader";
import * as schema from "../../src/db/schema";
import {
  organization,
  pacaProjects,
  pacaSprints,
  pacaTaskLinks,
  pacaTasks,
  user,
} from "../../src/db/schema";

const databaseURL = process.env.PACA_TEST_DATABASE_URL?.trim();
if (process.env.PACA_REQUIRE_POSTGRES_CONTRACTS === "true" && !databaseURL) {
  throw new Error("PACA_TEST_DATABASE_URL_REQUIRED");
}

(databaseURL ? describe : describe.skip)("PostgreSQL Automation condition reader", () => {
  it("selects ordered task, target and sprint branches within the project", async () => {
    if (!databaseURL) throw new Error("PACA_TEST_DATABASE_URL_REQUIRED");
    const client = new Client({ connectionString: databaseURL });
    await client.connect();
    const database = drizzle(client, { schema });
    const suffix = crypto.randomUUID();
    const userId = `automation-condition-${suffix}`;
    const organizationId = `automation-condition-org-${suffix}`;
    try {
      await database.insert(user).values({
        id: userId,
        name: "Condition User",
        email: `${userId}@paca.test`,
        emailVerified: true,
      });
      await database.insert(organization).values({
        id: organizationId,
        name: "Condition Org",
        slug: organizationId,
        createdAt: new Date(),
      });
      const [project, otherProject] = await database
        .insert(pacaProjects)
        .values([
          { organizationId, name: "Condition", slug: `condition-${suffix}`, createdBy: userId },
          { organizationId, name: "Other", slug: `other-${suffix}`, createdBy: userId },
        ])
        .returning();
      if (!project || !otherProject) throw new Error("AUTOMATION_CONDITION_PROJECT_MISSING");
      const [sprint] = await database
        .insert(pacaSprints)
        .values({ projectId: project.id, name: "Release", status: "active" })
        .returning();
      if (!sprint) throw new Error("AUTOMATION_CONDITION_SPRINT_MISSING");
      const [parent, firstChild, secondChild, linked, external] = await database
        .insert(pacaTasks)
        .values([
          {
            projectId: project.id,
            taskNumber: 1,
            title: "Parent",
            importance: 5,
            sprintId: sprint.id,
          },
          {
            projectId: project.id,
            taskNumber: 2,
            title: "Child A",
            parentTaskId: null,
            tags: ["review"],
          },
          { projectId: project.id, taskNumber: 3, title: "Child B", parentTaskId: null, tags: [] },
          { projectId: project.id, taskNumber: 4, title: "Blocked", tags: ["urgent"] },
          { projectId: otherProject.id, taskNumber: 1, title: "External" },
        ])
        .returning();
      if (!parent || !firstChild || !secondChild || !linked || !external) {
        throw new Error("AUTOMATION_CONDITION_TASK_MISSING");
      }
      await database
        .update(pacaTasks)
        .set({ parentTaskId: parent.id })
        .where(eq(pacaTasks.id, firstChild.id));
      await database
        .update(pacaTasks)
        .set({ parentTaskId: parent.id })
        .where(eq(pacaTasks.id, secondChild.id));
      await database.insert(pacaTaskLinks).values([
        {
          projectId: project.id,
          sourceTaskId: parent.id,
          targetTaskId: linked.id,
          linkType: "blocks",
        },
        {
          projectId: project.id,
          sourceTaskId: parent.id,
          targetTaskId: secondChild.id,
          linkType: "relates_to",
        },
        {
          projectId: project.id,
          sourceTaskId: parent.id,
          targetTaskId: firstChild.id,
          linkType: "duplicates",
        },
      ]);

      const reader = new PostgresAutomationConditionReader(database);
      const node = (branches: unknown[]) => ({
        id: crypto.randomUUID(),
        kind: "condition" as const,
        type: "condition",
        config: { branches },
      });
      expect(
        await reader.selectHandle(
          project.id,
          parent.id,
          node([
            { handle: "wrong", tree: { field: "importance", operator: "less_than", value: "5" } },
            { handle: "priority", tree: { field: "importance", operator: "equals", value: "5" } },
          ]),
        ),
      ).toBe("priority");
      expect(
        await reader.selectHandle(
          project.id,
          parent.id,
          node([
            {
              handle: "all",
              tree: {
                field: "tags",
                operator: "contains",
                value: "review",
                target: { kind: "children" },
                match_mode: "all",
              },
            },
            {
              handle: "any",
              tree: {
                field: "tags",
                operator: "contains",
                value: "review",
                target: { kind: "children" },
                match_mode: "any",
              },
            },
          ]),
        ),
      ).toBe("any");
      expect(
        await reader.selectHandle(
          project.id,
          firstChild.id,
          node([
            {
              handle: "parent",
              tree: {
                field: "title",
                operator: "equals",
                value: "Parent",
                target: { kind: "parent" },
              },
            },
          ]),
        ),
      ).toBe("parent");
      expect(
        await reader.selectHandle(
          project.id,
          parent.id,
          node([
            {
              handle: "blocked",
              tree: {
                field: "tags",
                operator: "contains",
                value: "urgent",
                target: { kind: "blocks" },
              },
            },
          ]),
        ),
      ).toBe("blocked");
      expect(
        await reader.selectHandle(
          project.id,
          parent.id,
          node([
            {
              handle: "sprint",
              tree: { field: "sprint_status", operator: "equals", value: "active" },
            },
          ]),
        ),
      ).toBe("sprint");
      expect(
        await reader.selectHandle(
          project.id,
          parent.id,
          node([
            {
              handle: "leak",
              tree: {
                field: "title",
                operator: "equals",
                value: "External",
                target: { kind: "other", other_task_id: external.id },
              },
            },
          ]),
        ),
      ).toBe("else");
      expect(
        await reader.selectHandle(
          project.id,
          linked.id,
          node([
            {
              handle: "inverse",
              tree: {
                field: "title",
                operator: "equals",
                value: "Parent",
                target: { kind: "is_blocked_by" },
              },
            },
          ]),
        ),
      ).toBe("inverse");

      const targets = new PostgresAutomationTargetReader(database);
      expect(await targets.resolveTaskIds(project.id, parent.id, { kind: "self" })).toEqual([
        parent.id,
      ]);
      expect(await targets.resolveTaskIds(project.id, firstChild.id, { kind: "parent" })).toEqual([
        parent.id,
      ]);
      expect(await targets.resolveTaskIds(project.id, parent.id, { kind: "children" })).toEqual(
        [firstChild.id, secondChild.id].sort(),
      );
      expect(await targets.resolveTaskIds(project.id, parent.id, { kind: "blocks" })).toEqual([
        linked.id,
      ]);
      expect(
        await targets.resolveTaskIds(project.id, linked.id, { kind: "is_blocked_by" }),
      ).toEqual([parent.id]);
      expect(await targets.resolveTaskIds(project.id, parent.id, { kind: "relates_to" })).toEqual([
        secondChild.id,
      ]);
      expect(await targets.resolveTaskIds(project.id, parent.id, { kind: "duplicates" })).toEqual([
        firstChild.id,
      ]);
      expect(
        await targets.resolveTaskIds(project.id, firstChild.id, { kind: "is_duplicated_by" }),
      ).toEqual([parent.id]);
      expect(
        await targets.resolveTaskIds(project.id, parent.id, {
          kind: "other",
          other_task_id: firstChild.id,
        }),
      ).toEqual([firstChild.id]);
      await expect(
        targets.resolveTaskIds(project.id, parent.id, {
          kind: "other",
          other_task_id: external.id,
        }),
      ).rejects.toThrow("AUTOMATION_TARGET_NOT_FOUND");
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
