import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import type { PacaDatabase } from "../../src/database";
import * as schema from "../../src/db/schema";
import { organization, pacaDocuments, pacaProjects, pacaTasks, user } from "../../src/db/schema";
import { PostgresProjectSearchRepository } from "../../src/search/postgres-repository";
import { ProjectSearchService } from "../../src/search/service";

const databaseURL = process.env.PACA_TEST_DATABASE_URL?.trim();
if (process.env.PACA_REQUIRE_POSTGRES_CONTRACTS === "true" && !databaseURL)
  throw Error("PACA_TEST_DATABASE_URL_REQUIRED");
function required<T>(value: T | undefined): T {
  if (value === undefined) throw Error("FIXTURE_VALUE_MISSING");
  return value;
}
const text = (value: string) => ({ type: "text", text: value, styles: {} });
const paragraph = (value: unknown[]) => ({
  id: crypto.randomUUID(),
  type: "paragraph",
  props: {},
  content: value,
  children: [],
});
async function fixture(
  run: (context: {
    service: ProjectSearchService;
    projectId: string;
    otherProjectId: string;
    taskIds: string[];
    docIds: string[];
    database: PacaDatabase;
  }) => Promise<void>,
) {
  const client = new Client({ connectionString: databaseURL });
  await client.connect();
  const database = drizzle(client, { schema });
  const organizationId = `search-${crypto.randomUUID()}`;
  const userId = crypto.randomUUID();
  try {
    await database.insert(user).values({
      id: userId,
      name: "Search tester",
      email: `${userId}@example.test`,
      emailVerified: true,
    });
    await database
      .insert(organization)
      .values({ id: organizationId, name: "Search", slug: organizationId, createdAt: new Date() });
    const projects = await database
      .insert(pacaProjects)
      .values([
        { organizationId, createdBy: userId, name: "Search", slug: `main-${organizationId}` },
        { organizationId, createdBy: userId, name: "Other", slug: `other-${organizationId}` },
      ])
      .returning();
    const projectId = required(projects[0]).id;
    const otherProjectId = required(projects[1]).id;
    const content = [
      paragraph([
        text("Nested 上"),
        { ...text("下文"), styles: { bold: true } },
        text(" marker 100% a_b a\\b"),
      ]),
      paragraph([
        {
          type: "link",
          href: "https://secret.invalid/hiddenneedle",
          content: [text("linked"), text("phrase")],
        },
      ]),
      { ...paragraph([]), children: [paragraph([text("childneedle")])] },
      {
        type: "table",
        id: crypto.randomUUID(),
        content: {
          type: "tableContent",
          rows: [{ cells: [[text("cellone")], [text("celltwo")]] }],
        },
      },
      paragraph([text("end")]),
      paragraph([text("start")]),
      { type: "paragraph", props: { text: "hiddenneedle" }, content: [] },
    ];
    const tasks = await database
      .insert(pacaTasks)
      .values([
        {
          projectId,
          taskNumber: 1,
          title: "First",
          description: content,
          createdAt: new Date("2026-10-01T00:00:00Z"),
        },
        {
          projectId,
          taskNumber: 2,
          title: "Second",
          description: [
            paragraph([text(`marker ${"x".repeat(1000)} tailneedle ${"z".repeat(1000)}`)]),
          ],
          createdAt: new Date("2026-10-01T00:00:00Z"),
        },
        { projectId, taskNumber: 3, title: "marker deleted", deletedAt: new Date() },
        { projectId: otherProjectId, taskNumber: 1, title: "marker foreign", description: content },
      ])
      .returning({ id: pacaTasks.id });
    const docs = await database
      .insert(pacaDocuments)
      .values([
        { projectId, title: "Guide", content },
        { projectId, title: "Other guide", content: [paragraph([text("marker")])] },
        { projectId, title: "marker deleted", deletedAt: new Date() },
        { projectId: otherProjectId, title: "marker foreign", content },
      ])
      .returning({ id: pacaDocuments.id });
    await run({
      service: new ProjectSearchService(new PostgresProjectSearchRepository(database)),
      projectId,
      otherProjectId,
      taskIds: tasks.map((t) => t.id),
      docIds: docs.map((d) => d.id),
      database,
    });
  } finally {
    await database.delete(organization).where(eq(organization.id, organizationId));
    await database.delete(user).where(eq(user.id, userId));
    await client.end();
  }
}
describe.skipIf(!databaseURL)("PostgreSQL project body search", () => {
  it("updates its generated projection atomically, including rollback and empty bodies", async () =>
    fixture(async ({ database, service, projectId, taskIds, docIds }) => {
      const taskId = required(taskIds[0]);
      const docId = required(docIds[0]);
      await database
        .update(pacaTasks)
        .set({ description: [paragraph([text("fresh-task-needle")])] })
        .where(eq(pacaTasks.id, taskId));
      await database
        .update(pacaDocuments)
        .set({ content: [paragraph([text("fresh-doc-needle")])] })
        .where(eq(pacaDocuments.id, docId));
      expect(
        (await service.search({ projectId, kind: "tasks", query: "fresh-task-needle" })).items.map(
          (item) => item.id,
        ),
      ).toEqual([taskId]);
      expect(
        (await service.search({ projectId, kind: "docs", query: "fresh-doc-needle" })).items.map(
          (item) => item.id,
        ),
      ).toEqual([docId]);
      await expect(
        database.transaction(async (transaction) => {
          await transaction
            .update(pacaDocuments)
            .set({ content: [paragraph([text("rolled-back-needle")])] })
            .where(eq(pacaDocuments.id, docId));
          throw new Error("ROLLBACK_SEARCH");
        }),
      ).rejects.toThrow("ROLLBACK_SEARCH");
      expect(
        (await service.search({ projectId, kind: "docs", query: "rolled-back-needle" })).items,
      ).toEqual([]);
      expect(
        (await service.search({ projectId, kind: "docs", query: "fresh-doc-needle" })).items,
      ).toHaveLength(1);
      await database
        .update(pacaDocuments)
        .set({ content: null })
        .where(eq(pacaDocuments.id, docId));
      expect(
        (await service.search({ projectId, kind: "docs", query: "fresh-doc-needle" })).items,
      ).toEqual([]);
    }));
  it(
    "keeps large project searches bounded and has usable trigram indexes",
    async () =>
      fixture(async ({ database, service, projectId }) => {
        await database.execute(sql`insert into paca_document(project_id,title,content)
      select ${projectId}::uuid,'Load fixture '||n,jsonb_build_array(jsonb_build_object('type','paragraph','content',jsonb_build_array(jsonb_build_object('type','text','text',repeat('ordinary words ',30)||case when n=4999 then 'unique-benchmark-needle' else 'filler' end))))
      from generate_series(1,5000) n`);
        await database.execute(sql`analyze paca_document`);
        const started = performance.now();
        const page = await service.search({
          projectId,
          kind: "docs",
          query: "unique-benchmark-needle",
        });
        expect(page.items).toHaveLength(1);
        expect(performance.now() - started).toBeLessThan(5000);
        // The planner may prefer a sequential scan for this small local
        // fixture. Confirm index eligibility independently of its cost choice.
        const plan = await database.transaction(async (transaction) => {
          await transaction.execute(sql`set local enable_seqscan = off`);
          return transaction.execute(
            sql`explain (format json) select id from paca_document where deleted_at is null and search_body ilike '%unique-benchmark-needle%'`,
          );
        });
        expect(JSON.stringify(plan.rows)).toContain("paca_document_search_body_idx");
      }),
    15000,
  );
  it.each([
    "tasks",
    "docs",
  ] as const)("finds formatted Chinese, links, children and table text for %s", async (kind) =>
    fixture(async ({ service, projectId }) => {
      for (const query of ["上下文", "linkedphrase", "childneedle", "cellone"]) {
        const page = await service.search({ kind, projectId, query });
        expect(page.items).toHaveLength(1);
        expect(required(page.items[0]).matchedIn).toBe("content");
        expect(required(page.items[0]).snippet).toContain(query);
      }
    }));
  it.each([
    "tasks",
    "docs",
  ] as const)("does not search structural keys/props/URLs or concatenate separate blocks/cells for %s", async (kind) =>
    fixture(async ({ service, projectId }) => {
      for (const query of ["paragraph", "hiddenneedle", "endstart", "cellonecelltwo"])
        expect((await service.search({ kind, projectId, query })).items).toEqual([]);
    }));
  it.each(["%", "a_b", "a\\b"])("matches literal %s rather than wildcard patterns", async (query) =>
    fixture(async ({ service, projectId }) => {
      expect((await service.search({ kind: "tasks", projectId, query })).items).toHaveLength(1);
    }));
  it("returns task numbers and bounded excerpts around the actual match", async () =>
    fixture(async ({ service, projectId }) => {
      const number = await service.search({ kind: "tasks", projectId, query: "#1" });
      expect(number.items).toHaveLength(1);
      expect(required(number.items[0]).matchedIn).toBe("title");
      const match = await service.search({ kind: "tasks", projectId, query: "tailneedle" });
      expect(required(match.items[0]).snippet).toContain("tailneedle");
      expect(required(match.items[0]).snippet.length).toBeLessThanOrEqual(240);
      expect(Object.keys(required(match.items[0]))).not.toContain("description");
    }));
  it.each([
    "tasks",
    "docs",
  ] as const)("isolates projects, soft deletions, Agent IDs and pagination for %s", async (kind) =>
    fixture(async ({ service, projectId, otherProjectId, taskIds, docIds }) => {
      const ids = kind === "tasks" ? taskIds : docIds;
      const first = await service.search({ kind, projectId, query: "marker", limit: 1 });
      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();
      const second = await service.search({
        kind,
        projectId,
        query: "marker",
        limit: 1,
        cursor: first.nextCursor ?? undefined,
      });
      expect(second.items).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      expect(required(second.items[0]).id).not.toBe(required(first.items[0]).id);
      expect(
        (
          await service.search({ kind, projectId, query: "marker" }, [
            required(ids[0]),
            required(ids[3]),
          ])
        ).items.map((item) => item.id),
      ).toEqual([required(ids[0])]);
      expect((await service.search({ kind, projectId, query: "marker" }, [])).items).toEqual([]);
      await expect(
        service.search({
          kind,
          projectId: otherProjectId,
          query: "marker",
          cursor: first.nextCursor ?? undefined,
        }),
      ).rejects.toMatchObject({ code: "SEARCH_CURSOR_INVALID" });
      await expect(
        service.search({ kind, projectId, query: "other", cursor: first.nextCursor ?? undefined }),
      ).rejects.toMatchObject({ code: "SEARCH_CURSOR_INVALID" });
    }));
  it("does not return records from an archived project", async () =>
    fixture(async ({ service, projectId, database }) => {
      await database
        .update(pacaProjects)
        .set({ status: "archived" })
        .where(eq(pacaProjects.id, projectId));
      expect((await service.search({ kind: "docs", projectId, query: "marker" })).items).toEqual(
        [],
      );
    }));
});
