import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migrationURL = new URL("../drizzle/0001_lame_the_enforcers.sql", import.meta.url);
const snapshotURL = new URL("../drizzle/meta/0001_snapshot.json", import.meta.url);
const projectMigrationURL = new URL("../drizzle/0002_wooden_shaman.sql", import.meta.url);
const projectSnapshotURL = new URL("../drizzle/meta/0002_snapshot.json", import.meta.url);
const projectRoleMigrationURL = new URL("../drizzle/0003_black_runaways.sql", import.meta.url);
const projectRoleSnapshotURL = new URL("../drizzle/meta/0003_snapshot.json", import.meta.url);
const organizationAccessMigrationURL = new URL(
  "../drizzle/0004_melodic_gargoyle.sql",
  import.meta.url,
);
const organizationAccessSnapshotURL = new URL(
  "../drizzle/meta/0004_snapshot.json",
  import.meta.url,
);
const taskMigrationURL = new URL("../drizzle/0005_true_taskmaster.sql", import.meta.url);
const taskSnapshotURL = new URL("../drizzle/meta/0005_snapshot.json", import.meta.url);
const taskActivityMigrationURL = new URL("../drizzle/0006_awesome_legion.sql", import.meta.url);
const taskActivitySnapshotURL = new URL("../drizzle/meta/0006_snapshot.json", import.meta.url);
const iterationMigrationURL = new URL("../drizzle/0007_yummy_microbe.sql", import.meta.url);
const iterationSnapshotURL = new URL("../drizzle/meta/0007_snapshot.json", import.meta.url);
const taskLinkMigrationURL = new URL("../drizzle/0013_glorious_miracleman.sql", import.meta.url);
const taskLinkSnapshotURL = new URL("../drizzle/meta/0013_snapshot.json", import.meta.url);
const attachmentRunGuardMigrationURL = new URL("../drizzle/0014_clear_ultron.sql", import.meta.url);
const attachmentRunGuardSnapshotURL = new URL(
  "../drizzle/meta/0014_snapshot.json",
  import.meta.url,
);

const applicationTables = [
  "user",
  "session",
  "account",
  "verification",
  "organization",
  "member",
  "invitation",
  "paca_system_role",
  "paca_system_role_permission",
  "paca_user_system_role",
  "paca_organization_role",
  "paca_organization_role_permission",
  "paca_organization_member_role",
  "paca_project",
  "paca_project_role",
  "paca_role_permission",
  "paca_project_member",
  "paca_project_member_role",
  "paca_task_type",
  "paca_task_status",
  "paca_task_counter",
  "paca_sprint",
  "paca_custom_field_definition",
  "paca_task_view",
  "paca_view_task_position",
  "paca_task",
  "paca_task_assignee",
  "paca_task_activity",
  "paca_task_link",
] as const;

describe("reviewed permission migration", () => {
  it("is transactional and records the exact Drizzle snapshot checksum", async () => {
    const [migration, snapshot] = await Promise.all([
      readFile(migrationURL, "utf8"),
      readFile(snapshotURL),
    ]);
    const checksum = createHash("sha256").update(snapshot).digest("hex");

    expect(migration.trimStart()).toMatch(/^BEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    expect(migration).toContain(`VALUES ('0001_lame_the_enforcers', '${checksum}')`);
  });

  it("creates the member composite key before any foreign key references it", async () => {
    const migration = await readFile(migrationURL, "utf8");
    const uniqueConstraint = migration.indexOf("member_id_organization_unique");
    const referencingForeignKey = migration.indexOf(
      "paca_organization_member_role_member_organization_fk",
    );

    expect(uniqueConstraint).toBeGreaterThan(-1);
    expect(referencingForeignKey).toBeGreaterThan(uniqueConstraint);
  });

  it("keeps the project projection migration transactional and checksummed", async () => {
    const [migration, snapshot] = await Promise.all([
      readFile(projectMigrationURL, "utf8"),
      readFile(projectSnapshotURL),
    ]);
    const checksum = createHash("sha256").update(snapshot).digest("hex");

    expect(migration.trimStart()).toMatch(/^BEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    expect(migration).toContain(`VALUES ('0002_wooden_shaman', '${checksum}')`);
    expect(migration).toContain('ADD COLUMN "task_id_prefix"');
    expect(migration).toContain('ADD COLUMN "is_public"');
    expect(migration).toContain('ADD COLUMN "settings"');
  });

  it("makes project role names case-insensitively unique in a reviewed migration", async () => {
    const [migration, snapshot] = await Promise.all([
      readFile(projectRoleMigrationURL, "utf8"),
      readFile(projectRoleSnapshotURL),
    ]);
    const checksum = createHash("sha256").update(snapshot).digest("hex");

    expect(migration.trimStart()).toMatch(/^BEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    expect(migration).toContain(`VALUES ('0003_black_runaways', '${checksum}')`);
    expect(migration).toContain('("project_id",lower("name"))');
  });

  it("adds reviewed organization access grants and a case-insensitive role index", async () => {
    const [migration, snapshot] = await Promise.all([
      readFile(organizationAccessMigrationURL, "utf8"),
      readFile(organizationAccessSnapshotURL),
    ]);
    const checksum = createHash("sha256").update(snapshot).digest("hex");

    expect(migration.trimStart()).toMatch(/^BEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    expect(migration).toContain(`VALUES ('0004_melodic_gargoyle', '${checksum}')`);
    expect(migration).toContain('("organization_id",lower("name"))');
    expect(migration).toContain("'organizationMembers', '*'");
    expect(migration).toContain("'organizationRoles', 'read'");
  });

  it("creates the task foundation transactionally and seeds every active project", async () => {
    const [migration, snapshot] = await Promise.all([
      readFile(taskMigrationURL, "utf8"),
      readFile(taskSnapshotURL),
    ]);
    const checksum = createHash("sha256").update(snapshot).digest("hex");

    expect(migration.trimStart()).toMatch(/^BEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    expect(migration).toContain(`VALUES ('0005_true_taskmaster', '${checksum}')`);
    expect(migration).toContain('CREATE TABLE "paca_task"');
    expect(migration).toContain('CREATE TABLE "paca_task_counter"');
    expect(migration).toContain('FROM "paca_project" p');
    expect(migration).toContain("'Backlog', '#64748b', 0, 'backlog', true");
  });

  it("adds the task activity ledger transactionally with trusted actor references", async () => {
    const [migration, snapshot] = await Promise.all([
      readFile(taskActivityMigrationURL, "utf8"),
      readFile(taskActivitySnapshotURL),
    ]);
    const checksum = createHash("sha256").update(snapshot).digest("hex");

    expect(migration.trimStart()).toMatch(/^BEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    expect(migration).toContain(`VALUES ('0006_awesome_legion', '${checksum}')`);
    expect(migration).toContain('CREATE TABLE "paca_task_activity"');
    expect(migration).toContain('"actor_user_id" text');
    expect(migration).toContain('"actor_member_id" uuid');
    expect(migration).toContain('CONSTRAINT "paca_task_activity_task_project_fk"');
  });

  it("adds iterations, views, task positioning and custom fields in a reviewed migration", async () => {
    const [migration, snapshot] = await Promise.all([
      readFile(iterationMigrationURL, "utf8"),
      readFile(iterationSnapshotURL),
    ]);
    const checksum = createHash("sha256").update(snapshot).digest("hex");

    expect(migration.trimStart()).toMatch(/^BEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    expect(migration).toContain(`VALUES ('0007_yummy_microbe', '${checksum}')`);
    expect(migration).toContain('CREATE TABLE "paca_sprint"');
    expect(migration).toContain('CREATE TABLE "paca_custom_field_definition"');
    expect(migration).toContain('CREATE TABLE "paca_task_view"');
    expect(migration).toContain('CREATE TABLE "paca_view_task_position"');
    expect(migration).toContain('ON DELETE SET NULL ("sprint_id")');
    expect(migration).toContain("v.\"view_context\" = 'backlog'");
    expect(migration).toContain("v.\"view_context\" = 'timeline'");
  });

  it("adds project-scoped task links with reviewed direction and integrity constraints", async () => {
    const [migration, snapshot] = await Promise.all([
      readFile(taskLinkMigrationURL, "utf8"),
      readFile(taskLinkSnapshotURL),
    ]);
    const checksum = createHash("sha256").update(snapshot).digest("hex");

    expect(migration.trimStart()).toMatch(/^BEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    expect(migration).toContain(`VALUES ('0013_glorious_miracleman', '${checksum}')`);
    expect(migration).toContain('CREATE TABLE "paca_task_link"');
    expect(migration).toContain('CONSTRAINT "paca_task_link_source_project_fk"');
    expect(migration).toContain('CONSTRAINT "paca_task_link_target_project_fk"');
    expect(migration).toContain('CONSTRAINT "paca_task_link_no_self_check"');
    expect(migration).toContain("in ('blocks', 'relates_to', 'duplicates')");
  });

  it("prevents one source attachment from belonging to multiple active migration runs", async () => {
    const [migration, snapshot] = await Promise.all([
      readFile(attachmentRunGuardMigrationURL, "utf8"),
      readFile(attachmentRunGuardSnapshotURL),
    ]);
    const checksum = createHash("sha256").update(snapshot).digest("hex");

    expect(migration.trimStart()).toMatch(/^BEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    expect(migration).toContain(`VALUES ('0014_clear_ultron', '${checksum}')`);
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "paca_attachment_migration_active_source_uidx"',
    );
    expect(migration).toContain(
      'WHERE "paca_attachment_migration_item"."status" <> \'rolled_back\'',
    );
  });

  it("keeps runtime role grants explicit for every non-ledger application table", async () => {
    const directory = fileURLToPath(new URL("../scripts/sql/", import.meta.url));
    const [grant, verify] = await Promise.all([
      readFile(`${directory}/grant-runtime-role.sql`, "utf8"),
      readFile(`${directory}/verify-runtime-role.sql`, "utf8"),
    ]);

    for (const table of applicationTables) {
      expect(grant, `grant list is missing ${table}`).toContain(table);
      expect(verify, `verification list is missing ${table}`).toContain(table);
    }
    expect(grant).toContain("REVOKE ALL PRIVILEGES ON TABLE public.paca_schema_migration");
  });
});
