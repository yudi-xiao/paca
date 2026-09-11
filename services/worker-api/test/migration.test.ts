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
const documentMigrationURL = new URL("../drizzle/0016_busy_changeling.sql", import.meta.url);
const documentSnapshotURL = new URL("../drizzle/meta/0016_snapshot.json", import.meta.url);
const documentSnapshotMigrationURL = new URL("../drizzle/0017_last_toro.sql", import.meta.url);
const documentSnapshotSnapshotURL = new URL("../drizzle/meta/0017_snapshot.json", import.meta.url);
const agentHostRuntimeMigrationURL = new URL("../drizzle/0019_volatile_hydra.sql", import.meta.url);
const agentHostRuntimeSnapshotURL = new URL("../drizzle/meta/0019_snapshot.json", import.meta.url);
const agentTaskCancelMigrationURL = new URL(
  "../drizzle/0020_pale_the_santerians.sql",
  import.meta.url,
);
const agentTaskCancelSnapshotURL = new URL("../drizzle/meta/0020_snapshot.json", import.meta.url);
const agentTaskRecoveryMigrationURL = new URL("../drizzle/0021_neat_dagger.sql", import.meta.url);
const agentTaskRecoverySnapshotURL = new URL("../drizzle/meta/0021_snapshot.json", import.meta.url);
const notificationMigrationURL = new URL("../drizzle/0022_fine_molten_man.sql", import.meta.url);
const notificationSnapshotURL = new URL("../drizzle/meta/0022_snapshot.json", import.meta.url);
const brandingMigrationURL = new URL("../drizzle/0023_worried_paibok.sql", import.meta.url);
const brandingSnapshotURL = new URL("../drizzle/meta/0023_snapshot.json", import.meta.url);
const environmentScopeMigrationURL = new URL("../drizzle/0024_deep_nomad.sql", import.meta.url);
const environmentScopeSnapshotURL = new URL("../drizzle/meta/0024_snapshot.json", import.meta.url);
const environmentBackendMigrationURL = new URL(
  "../drizzle/0025_moaning_wild_pack.sql",
  import.meta.url,
);
const environmentBackendSnapshotURL = new URL(
  "../drizzle/meta/0025_snapshot.json",
  import.meta.url,
);
const environmentResourceMigrationURL = new URL(
  "../drizzle/0026_nosy_gamma_corps.sql",
  import.meta.url,
);
const environmentResourceSnapshotURL = new URL(
  "../drizzle/meta/0026_snapshot.json",
  import.meta.url,
);
const removeAttachmentMigrationLedgerURL = new URL(
  "../drizzle/0027_goofy_warstar.sql",
  import.meta.url,
);
const removeAttachmentMigrationLedgerSnapshotURL = new URL(
  "../drizzle/meta/0027_snapshot.json",
  import.meta.url,
);
const removeLegacyEnvironmentBackendMigrationURL = new URL(
  "../drizzle/0028_unknown_thunderbolts.sql",
  import.meta.url,
);
const removeLegacyEnvironmentBackendSnapshotURL = new URL(
  "../drizzle/meta/0028_snapshot.json",
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
  "paca_environment_scope",
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
  "paca_notification",
  "paca_branding_upload",
  "paca_workspace_settings",
  "paca_task_link",
  "paca_document",
  "paca_agent_host_runtime",
  "paca_agent_task_requirement",
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

  it("adds user-manageable environment metadata with a safe existing-row backfill", async () => {
    const [migration, snapshot] = await Promise.all([
      readFile(environmentResourceMigrationURL, "utf8"),
      readFile(environmentResourceSnapshotURL),
    ]);
    const checksum = createHash("sha256").update(snapshot).digest("hex");

    expect(migration.trimStart()).toMatch(/^BEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    expect(migration).toContain(`VALUES ('0026_nosy_gamma_corps', '${checksum}')`);
    expect(migration).toContain('ADD COLUMN "name" text');
    expect(migration).toContain("'Environment ' || left(\"environment_id\"::text, 8)");
    expect(migration).toContain('ALTER COLUMN "name" SET NOT NULL');
    expect(migration).toContain('ADD COLUMN "created_by" text');
    expect(migration).toContain("paca_environment_scope_project_name_uidx");
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

  it("adds the document projection and its project realtime outbox trigger transactionally", async () => {
    const [migration, snapshot] = await Promise.all([
      readFile(documentMigrationURL, "utf8"),
      readFile(documentSnapshotURL),
    ]);
    const checksum = createHash("sha256").update(snapshot).digest("hex");

    expect(migration.trimStart()).toMatch(/^BEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    expect(migration).toContain(`VALUES ('0016_busy_changeling', '${checksum}')`);
    expect(migration).toContain('CREATE TABLE "paca_document"');
    expect(migration).toContain("CREATE TRIGGER paca_document_realtime_outbox");
    expect(migration).toContain("'document_id', row_value.id::text");
  });

  it("adds versioned Yjs snapshot metadata transactionally", async () => {
    const [migration, snapshot] = await Promise.all([
      readFile(documentSnapshotMigrationURL, "utf8"),
      readFile(documentSnapshotSnapshotURL),
    ]);
    const checksum = createHash("sha256").update(snapshot).digest("hex");

    expect(migration.trimStart()).toMatch(/^BEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    expect(migration).toContain(`VALUES ('0017_last_toro', '${checksum}')`);
    expect(migration).toContain('ADD COLUMN "yjs_revision" bigint DEFAULT 0 NOT NULL');
    expect(migration).toContain('ADD COLUMN "yjs_snapshot_key" text');
    expect(migration).toContain('CONSTRAINT "paca_document_yjs_revision_check"');
  });

  it("adds Host presence and task matching labels transactionally", async () => {
    const [migration, snapshot] = await Promise.all([
      readFile(agentHostRuntimeMigrationURL, "utf8"),
      readFile(agentHostRuntimeSnapshotURL),
    ]);
    const checksum = createHash("sha256").update(snapshot).digest("hex");

    expect(migration.trimStart()).toMatch(/^BEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    expect(migration).toContain(`VALUES ('0019_volatile_hydra', '${checksum}')`);
    expect(migration).toContain('CREATE TABLE "paca_agent_host_runtime"');
    expect(migration).toContain('CREATE TABLE "paca_agent_task_requirement"');
    expect(migration).toContain("'[\"task:execute\"]'::jsonb");
  });

  it("adds trusted manual task lease cancellation audit fields transactionally", async () => {
    const [migration, snapshot] = await Promise.all([
      readFile(agentTaskCancelMigrationURL, "utf8"),
      readFile(agentTaskCancelSnapshotURL),
    ]);
    const checksum = createHash("sha256").update(snapshot).digest("hex");

    expect(migration.trimStart()).toMatch(/^BEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    expect(migration).toContain(`VALUES ('0020_pale_the_santerians', '${checksum}')`);
    expect(migration).toContain("ADD COLUMN \"actor_type\" text DEFAULT 'agent' NOT NULL");
    expect(migration).toContain("'cancel_request'");
  });

  it("adds the system lease expiry audit action transactionally", async () => {
    const [migration, snapshot] = await Promise.all([
      readFile(agentTaskRecoveryMigrationURL, "utf8"),
      readFile(agentTaskRecoverySnapshotURL),
    ]);
    const checksum = createHash("sha256").update(snapshot).digest("hex");

    expect(migration.trimStart()).toMatch(/^BEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    expect(migration).toContain(`VALUES ('0021_neat_dagger', '${checksum}')`);
    expect(migration).toContain("'expire'");
  });

  it("adds the Better Auth user notification projection transactionally", async () => {
    const [migration, snapshot] = await Promise.all([
      readFile(notificationMigrationURL, "utf8"),
      readFile(notificationSnapshotURL),
    ]);
    const checksum = createHash("sha256").update(snapshot).digest("hex");

    expect(migration.trimStart()).toMatch(/^BEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    expect(migration).toContain(`VALUES ('0022_fine_molten_man', '${checksum}')`);
    expect(migration).toContain('CREATE TABLE "paca_notification"');
    expect(migration).toContain('"recipient_user_id" text NOT NULL');
    expect(migration).toContain('"source_activity_id" uuid NOT NULL');
    expect(migration).toContain("paca_notification_source_recipient_type_uidx");
  });

  it("adds singleton workspace branding and immutable upload state transactionally", async () => {
    const [migration, snapshot] = await Promise.all([
      readFile(brandingMigrationURL, "utf8"),
      readFile(brandingSnapshotURL),
    ]);
    const checksum = createHash("sha256").update(snapshot).digest("hex");

    expect(migration.trimStart()).toMatch(/^BEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    expect(migration).toContain(`VALUES ('0023_worried_paibok', '${checksum}')`);
    expect(migration).toContain('CREATE TABLE "paca_branding_upload"');
    expect(migration).toContain('CREATE TABLE "paca_workspace_settings"');
    expect(migration).toContain('INSERT INTO "paca_workspace_settings" ("id") VALUES (true)');
    expect(migration).toContain("paca_branding_upload_status_check");
  });

  it("adds the explicit environment-to-project scope adapter transactionally", async () => {
    const [migration, snapshot] = await Promise.all([
      readFile(environmentScopeMigrationURL, "utf8"),
      readFile(environmentScopeSnapshotURL),
    ]);
    const checksum = createHash("sha256").update(snapshot).digest("hex");

    expect(migration.trimStart()).toMatch(/^BEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    expect(migration).toContain(`VALUES ('0024_deep_nomad', '${checksum}')`);
    expect(migration).toContain('CREATE TABLE "paca_environment_scope"');
    expect(migration).toContain("paca_environment_scope_project_id_paca_project_id_fk");
    expect(migration).toContain("paca_environment_scope_backend_check");
    expect(migration).not.toContain("secret");
  });

  it("adds the Cloudflare Sandbox provider without relabeling the Computer backend", async () => {
    const [migration, snapshot] = await Promise.all([
      readFile(environmentBackendMigrationURL, "utf8"),
      readFile(environmentBackendSnapshotURL),
    ]);
    const checksum = createHash("sha256").update(snapshot).digest("hex");

    expect(migration.trimStart()).toMatch(/^BEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    expect(migration).toContain(`VALUES ('0025_moaning_wild_pack', '${checksum}')`);
    expect(migration).toContain("'cloudflare-sandbox'");
    expect(migration).toContain("'cloudflare-computer'");
    expect(migration).toContain("'legacy-agent-runner'");
  });

  it("removes the obsolete attachment migration ledger without cascading", async () => {
    const [migration, snapshot] = await Promise.all([
      readFile(removeAttachmentMigrationLedgerURL, "utf8"),
      readFile(removeAttachmentMigrationLedgerSnapshotURL),
    ]);
    const checksum = createHash("sha256").update(snapshot).digest("hex");

    expect(migration.trimStart()).toMatch(/^BEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    expect(migration).toContain(`VALUES ('0027_goofy_warstar', '${checksum}')`);
    expect(migration).toContain('DROP TABLE "paca_attachment_migration_item";');
    expect(migration).not.toContain("CASCADE");
  });

  it("removes the legacy Agent Runner environment backend from the clean-slate schema", async () => {
    const [migration, snapshot] = await Promise.all([
      readFile(removeLegacyEnvironmentBackendMigrationURL, "utf8"),
      readFile(removeLegacyEnvironmentBackendSnapshotURL),
    ]);
    const checksum = createHash("sha256").update(snapshot).digest("hex");

    expect(migration.trimStart()).toMatch(/^BEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    expect(migration).toContain(`VALUES ('0028_unknown_thunderbolts', '${checksum}')`);
    expect(migration).toContain("'cloudflare-sandbox', 'cloudflare-computer'");
    expect(migration).not.toContain("legacy-agent-runner");
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
