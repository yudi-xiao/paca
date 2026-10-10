import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { GitHubDeliveryEvidence, GitHubDeliveryPolicy } from "../../github-delivery/evidence";
import type { TaskDelivery } from "../../github-delivery/service";
import { pacaAgentTaskLeases, pacaProjects, pacaTasks } from "./paca";

export const pacaGithubRepositories = pgTable(
  "paca_github_repository",
  {
    projectId: uuid("project_id")
      .primaryKey()
      .references(() => pacaProjects.id, { onDelete: "cascade" }),
    repositoryId: bigint("repository_id", { mode: "number" }).notNull(),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    policy: jsonb("policy").$type<GitHubDeliveryPolicy>().notNull(),
    version: integer("version").default(1).notNull(),
    status: text("status").$type<"active" | "revoked">().default("active").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("paca_github_repository_installation_idx").on(table.installationId, table.repositoryId),
    check(
      "paca_github_repository_ids_check",
      sql`${table.repositoryId} between 1 and 9007199254740991 and ${table.installationId} between 1 and 9007199254740991`,
    ),
    check("paca_github_repository_version_check", sql`${table.version} > 0`),
    check("paca_github_repository_status_check", sql`${table.status} in ('active', 'revoked')`),
    check("paca_github_repository_policy_check", sql`jsonb_typeof(${table.policy}) = 'object'`),
  ],
);
export const pacaGithubDeliveries = pgTable(
  "paca_github_delivery",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => pacaGithubRepositories.projectId, { onDelete: "cascade" }),
    taskId: uuid("task_id").notNull().unique(),
    leaseId: uuid("lease_id")
      .notNull()
      .unique()
      .references(() => pacaAgentTaskLeases.id, { onDelete: "cascade" }),
    repositoryId: bigint("repository_id", { mode: "number" }).notNull(),
    policyVersion: integer("policy_version").notNull(),
    version: integer("version").default(1).notNull(),
    pullNumber: bigint("pull_number", { mode: "number" }).notNull(),
    headSha: text("head_sha").notNull(),
    state: text("state").$type<TaskDelivery["state"]>().notNull(),
    evidence: jsonb("evidence").$type<GitHubDeliveryEvidence>().notNull(),
    acceptedBy: text("accepted_by"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    requestedChangesBy: text("requested_changes_by"),
    requestedChangesAt: timestamp("requested_changes_at", { withTimezone: true }),
    reviewNote: text("review_note").default("").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.taskId, table.projectId],
      foreignColumns: [pacaTasks.id, pacaTasks.projectId],
      name: "paca_github_delivery_task_project_fk",
    }).onDelete("cascade"),
    index("paca_github_delivery_pr_idx").on(table.repositoryId, table.pullNumber),
    index("paca_github_delivery_commit_idx").on(table.repositoryId, table.headSha),
    check(
      "paca_github_delivery_version_check",
      sql`${table.version} > 0 and ${table.policyVersion} > 0`,
    ),
    check(
      "paca_github_delivery_reference_check",
      sql`${table.pullNumber} between 1 and 9007199254740991 and ${table.headSha} ~ '^[a-f0-9]{40}$'`,
    ),
    check(
      "paca_github_delivery_state_check",
      sql`${table.state} in ('accepted', 'awaiting_acceptance', 'waiting', 'needs_changes', 'stale', 'unavailable')`,
    ),
    check(
      "paca_github_delivery_acceptance_check",
      sql`(${table.state} = 'accepted' and ${table.acceptedBy} is not null and ${table.acceptedAt} is not null) or (${table.state} <> 'accepted' and ${table.acceptedBy} is null and ${table.acceptedAt} is null)`,
    ),
    check(
      "paca_github_delivery_changes_check",
      sql`(${table.requestedChangesBy} is null and ${table.requestedChangesAt} is null) or (${table.state} = 'needs_changes' and ${table.requestedChangesBy} is not null and ${table.requestedChangesAt} is not null)`,
    ),
    check("paca_github_delivery_review_note_check", sql`length(${table.reviewNote}) <= 2000`),
  ],
);
// Audit identities are retained even when a user is deleted. No credentials,
// source files, PR bodies, review bodies, or prompt content are stored here.
export const pacaGithubDeliveryAudits = pgTable(
  "paca_github_delivery_audit",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => pacaProjects.id, { onDelete: "cascade" }),
    taskId: uuid("task_id"),
    requestId: uuid("request_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("paca_github_delivery_audit_request_unique").on(table.requestId),
    index("paca_github_delivery_audit_task_idx").on(table.projectId, table.taskId, table.createdAt),
    check(
      "paca_github_delivery_audit_action_check",
      sql`${table.action} in ('configure', 'submit', 'refresh', 'accept', 'request_changes')`,
    ),
  ],
);

// Store only a digest and routing metadata. Raw webhook payloads can contain
// private source text and review bodies and must never be retained.
export const pacaGithubWebhookReceipts = pgTable(
  "paca_github_webhook_receipt",
  {
    deliveryId: uuid("delivery_id").primaryKey(),
    digest: text("digest").notNull(),
    event: text("event").notNull(),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    repositoryId: bigint("repository_id", { mode: "number" }),
    affected: integer("affected").default(0).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("paca_github_webhook_receipt_received_idx").on(table.receivedAt),
    check("paca_github_webhook_receipt_digest_check", sql`${table.digest} ~ '^[a-f0-9]{64}$'`),
    check("paca_github_webhook_receipt_affected_check", sql`${table.affected} >= 0`),
  ],
);
