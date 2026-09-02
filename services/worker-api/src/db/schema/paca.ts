import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { agent, agentHost, member, organization, user } from "./auth";

export const pacaSchemaMigrations = pgTable("paca_schema_migration", {
  id: text("id").primaryKey(),
  checksum: text("checksum").notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).defaultNow().notNull(),
});

export const pacaSystemRoles = pgTable(
  "paca_system_role",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    description: text("description").default("").notNull(),
    isBuiltIn: boolean("is_built_in").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("paca_system_role_name_uidx").on(table.name)],
);

export const pacaSystemRolePermissions = pgTable(
  "paca_system_role_permission",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => pacaSystemRoles.id, { onDelete: "cascade" }),
    resource: text("resource").notNull(),
    action: text("action").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.roleId, table.resource, table.action] }),
    index("paca_system_role_permission_lookup_idx").on(table.resource, table.action),
  ],
);

export const pacaUserSystemRoles = pgTable(
  "paca_user_system_role",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => pacaSystemRoles.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.roleId] }),
    index("paca_user_system_role_role_idx").on(table.roleId),
  ],
);

export const pacaOrganizationRoles = pgTable(
  "paca_organization_role",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").default("").notNull(),
    isBuiltIn: boolean("is_built_in").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("paca_organization_role_organization_name_uidx").on(
      table.organizationId,
      sql`lower(${table.name})`,
    ),
    unique("paca_organization_role_id_organization_unique").on(table.id, table.organizationId),
    index("paca_organization_role_organization_idx").on(table.organizationId),
  ],
);

export const pacaOrganizationRolePermissions = pgTable(
  "paca_organization_role_permission",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => pacaOrganizationRoles.id, { onDelete: "cascade" }),
    resource: text("resource").notNull(),
    action: text("action").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.roleId, table.resource, table.action] }),
    index("paca_organization_role_permission_lookup_idx").on(table.resource, table.action),
  ],
);

export const pacaOrganizationMemberRoles = pgTable(
  "paca_organization_member_role",
  {
    memberId: text("member_id").notNull(),
    roleId: uuid("role_id").notNull(),
    organizationId: text("organization_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.memberId, table.roleId] }),
    foreignKey({
      columns: [table.memberId, table.organizationId],
      foreignColumns: [member.id, member.organizationId],
      name: "paca_organization_member_role_member_organization_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.roleId, table.organizationId],
      foreignColumns: [pacaOrganizationRoles.id, pacaOrganizationRoles.organizationId],
      name: "paca_organization_member_role_role_organization_fk",
    }).onDelete("cascade"),
    index("paca_organization_member_role_organization_idx").on(table.organizationId),
  ],
);

export const pacaProjects = pgTable(
  "paca_project",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description").default("").notNull(),
    taskIdPrefix: text("task_id_prefix").default("").notNull(),
    isPublic: boolean("is_public").default(false).notNull(),
    settings: jsonb("settings").$type<Record<string, unknown>>().default({}).notNull(),
    status: text("status").default("active").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("paca_project_organization_slug_uidx").on(table.organizationId, table.slug),
    uniqueIndex("paca_project_organization_name_uidx").on(
      table.organizationId,
      sql`lower(${table.name})`,
    ),
    index("paca_project_organization_idx").on(table.organizationId),
    check("paca_project_status_check", sql`${table.status} in ('active', 'archived')`),
  ],
);

export const pacaProjectRoles = pgTable(
  "paca_project_role",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => pacaProjects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").default("").notNull(),
    isBuiltIn: boolean("is_built_in").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("paca_project_role_project_name_uidx").on(
      table.projectId,
      sql`lower(${table.name})`,
    ),
    unique("paca_project_role_id_project_unique").on(table.id, table.projectId),
    index("paca_project_role_project_idx").on(table.projectId),
  ],
);

export const pacaRolePermissions = pgTable(
  "paca_role_permission",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => pacaProjectRoles.id, { onDelete: "cascade" }),
    resource: text("resource").notNull(),
    action: text("action").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.roleId, table.resource, table.action] }),
    index("paca_role_permission_lookup_idx").on(table.resource, table.action),
  ],
);

export const pacaProjectMembers = pgTable(
  "paca_project_member",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => pacaProjects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("paca_project_member_project_user_uidx").on(table.projectId, table.userId),
    unique("paca_project_member_id_project_unique").on(table.id, table.projectId),
    index("paca_project_member_user_idx").on(table.userId),
  ],
);

export const pacaProjectMemberRoles = pgTable(
  "paca_project_member_role",
  {
    memberId: uuid("member_id").notNull(),
    roleId: uuid("role_id").notNull(),
    projectId: uuid("project_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.memberId, table.roleId] }),
    foreignKey({
      columns: [table.memberId, table.projectId],
      foreignColumns: [pacaProjectMembers.id, pacaProjectMembers.projectId],
      name: "paca_project_member_role_member_project_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.roleId, table.projectId],
      foreignColumns: [pacaProjectRoles.id, pacaProjectRoles.projectId],
      name: "paca_project_member_role_role_project_fk",
    }).onDelete("cascade"),
    index("paca_project_member_role_project_idx").on(table.projectId),
  ],
);

export const pacaTaskTypes = pgTable(
  "paca_task_type",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => pacaProjects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    icon: text("icon"),
    color: text("color"),
    description: text("description"),
    isDefault: boolean("is_default").default(false).notNull(),
    isSystem: boolean("is_system").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("paca_task_type_id_project_unique").on(table.id, table.projectId),
    uniqueIndex("paca_task_type_project_name_uidx").on(table.projectId, sql`lower(${table.name})`),
    uniqueIndex("paca_task_type_project_default_uidx")
      .on(table.projectId)
      .where(sql`${table.isDefault} = true`),
    index("paca_task_type_project_idx").on(table.projectId),
  ],
);

export const pacaTaskStatuses = pgTable(
  "paca_task_status",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => pacaProjects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color"),
    position: integer("position").default(0).notNull(),
    category: text("category").notNull(),
    isDefault: boolean("is_default").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("paca_task_status_id_project_unique").on(table.id, table.projectId),
    uniqueIndex("paca_task_status_project_name_uidx").on(
      table.projectId,
      sql`lower(${table.name})`,
    ),
    uniqueIndex("paca_task_status_project_default_uidx")
      .on(table.projectId)
      .where(sql`${table.isDefault} = true`),
    index("paca_task_status_project_position_idx").on(table.projectId, table.position),
    check(
      "paca_task_status_category_check",
      sql`${table.category} in ('backlog', 'refinement', 'ready', 'todo', 'inprogress', 'done')`,
    ),
  ],
);

export const pacaTaskCounters = pgTable("paca_task_counter", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => pacaProjects.id, { onDelete: "cascade" }),
  lastValue: bigint("last_value", { mode: "number" }).default(0).notNull(),
});

export const pacaSprints = pgTable(
  "paca_sprint",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => pacaProjects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    startDate: date("start_date", { mode: "string" }),
    endDate: date("end_date", { mode: "string" }),
    goal: text("goal"),
    status: text("status").default("planned").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("paca_sprint_id_project_unique").on(table.id, table.projectId),
    index("paca_sprint_project_status_idx").on(table.projectId, table.status),
    index("paca_sprint_project_created_idx").on(table.projectId, table.createdAt),
    check("paca_sprint_status_check", sql`${table.status} in ('planned', 'active', 'completed')`),
    check(
      "paca_sprint_date_range_check",
      sql`${table.startDate} is null or ${table.endDate} is null or ${table.startDate} <= ${table.endDate}`,
    ),
  ],
);

export const pacaCustomFieldDefinitions = pgTable(
  "paca_custom_field_definition",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => pacaProjects.id, { onDelete: "cascade" }),
    fieldKey: text("field_key").notNull(),
    displayName: text("display_name").notNull(),
    fieldType: text("field_type").notNull(),
    options: jsonb("options").$type<string[]>().default([]).notNull(),
    isRequired: boolean("is_required").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("paca_custom_field_definition_id_project_unique").on(table.id, table.projectId),
    unique("paca_custom_field_definition_project_key_unique").on(table.projectId, table.fieldKey),
    index("paca_custom_field_definition_project_name_idx").on(table.projectId, table.displayName),
    check(
      "paca_custom_field_definition_type_check",
      sql`${table.fieldType} in ('text', 'number', 'date', 'select', 'multi_select', 'boolean', 'url')`,
    ),
  ],
);

export const pacaTaskViews = pgTable(
  "paca_task_view",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sprintId: uuid("sprint_id"),
    projectId: uuid("project_id")
      .notNull()
      .references(() => pacaProjects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    viewType: text("view_type").default("table").notNull(),
    viewContext: text("view_context").default("sprint").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().default({}).notNull(),
    position: doublePrecision("position").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("paca_task_view_id_project_unique").on(table.id, table.projectId),
    foreignKey({
      columns: [table.sprintId, table.projectId],
      foreignColumns: [pacaSprints.id, pacaSprints.projectId],
      name: "paca_task_view_sprint_project_fk",
    }).onDelete("cascade"),
    index("paca_task_view_sprint_position_idx").on(table.sprintId, table.position),
    index("paca_task_view_project_context_position_idx").on(
      table.projectId,
      table.viewContext,
      table.position,
    ),
    check(
      "paca_task_view_type_check",
      sql`${table.viewType} in ('table', 'board', 'roadmap', 'plugin')`,
    ),
    check(
      "paca_task_view_context_check",
      sql`${table.viewContext} in ('sprint', 'backlog', 'timeline')`,
    ),
    check(
      "paca_task_view_scope_check",
      sql`(${table.viewContext} = 'sprint' and ${table.sprintId} is not null) or (${table.viewContext} in ('backlog', 'timeline') and ${table.sprintId} is null)`,
    ),
  ],
);

export const pacaTasks = pgTable(
  "paca_task",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => pacaProjects.id, { onDelete: "cascade" }),
    taskNumber: bigint("task_number", { mode: "number" }).notNull(),
    taskTypeId: uuid("task_type_id").references(() => pacaTaskTypes.id, { onDelete: "set null" }),
    statusId: uuid("status_id").references(() => pacaTaskStatuses.id, { onDelete: "set null" }),
    sprintId: uuid("sprint_id"),
    parentTaskId: uuid("parent_task_id").references((): AnyPgColumn => pacaTasks.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    description: jsonb("description").$type<unknown[] | null>(),
    importance: integer("importance").default(0).notNull(),
    storyPoints: integer("story_points"),
    reporterId: uuid("reporter_id").references(() => pacaProjectMembers.id, {
      onDelete: "set null",
    }),
    customFields: jsonb("custom_fields").$type<Record<string, unknown>>().default({}).notNull(),
    startDate: date("start_date", { mode: "string" }),
    dueDate: date("due_date", { mode: "string" }),
    tags: jsonb("tags").$type<string[]>().default([]).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    unique("paca_task_id_project_unique").on(table.id, table.projectId),
    unique("paca_task_project_number_unique").on(table.projectId, table.taskNumber),
    foreignKey({
      columns: [table.sprintId, table.projectId],
      foreignColumns: [pacaSprints.id, pacaSprints.projectId],
      name: "paca_task_sprint_project_fk",
    }).onDelete("set null"),
    index("paca_task_project_number_idx").on(table.projectId, table.taskNumber),
    index("paca_task_project_status_idx").on(table.projectId, table.statusId),
    index("paca_task_project_sprint_idx").on(table.projectId, table.sprintId),
    index("paca_task_parent_idx").on(table.parentTaskId),
    check("paca_task_importance_check", sql`${table.importance} >= 0`),
    check(
      "paca_task_story_points_check",
      sql`${table.storyPoints} is null or ${table.storyPoints} >= 0`,
    ),
  ],
);

export type AgentTaskLeaseStatus = "active" | "cancelled" | "completed" | "expired" | "failed";

export const pacaAgentHostRuntimes = pgTable(
  "paca_agent_host_runtime",
  {
    hostId: text("host_id")
      .primaryKey()
      .references(() => agentHost.id, { onDelete: "cascade" }),
    approvedLabels: jsonb("approved_labels").$type<string[]>().default([]).notNull(),
    reportedLabels: jsonb("reported_labels").$type<string[]>().default([]).notNull(),
    reportedHarnessKinds: jsonb("reported_harness_kinds").$type<string[]>().default([]).notNull(),
    labelsVersion: integer("labels_version").default(1).notNull(),
    approvedBy: text("approved_by").references(() => user.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    heartbeatExpiresAt: timestamp("heartbeat_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("paca_agent_host_runtime_heartbeat_idx").on(table.heartbeatExpiresAt),
    check("paca_agent_host_runtime_labels_version_check", sql`${table.labelsVersion} >= 1`),
    check(
      "paca_agent_host_runtime_heartbeat_check",
      sql`(${table.lastHeartbeatAt} is null and ${table.heartbeatExpiresAt} is null) or (${table.lastHeartbeatAt} is not null and ${table.heartbeatExpiresAt} is not null and ${table.heartbeatExpiresAt} > ${table.lastHeartbeatAt})`,
    ),
    check(
      "paca_agent_host_runtime_approved_labels_check",
      sql`jsonb_typeof(${table.approvedLabels}) = 'array'`,
    ),
    check(
      "paca_agent_host_runtime_reported_labels_check",
      sql`jsonb_typeof(${table.reportedLabels}) = 'array'`,
    ),
    check(
      "paca_agent_host_runtime_harness_kinds_check",
      sql`jsonb_typeof(${table.reportedHarnessKinds}) = 'array'`,
    ),
  ],
);

export const pacaAgentTaskRequirements = pgTable(
  "paca_agent_task_requirement",
  {
    taskId: uuid("task_id").primaryKey(),
    projectId: uuid("project_id").notNull(),
    requiredLabels: jsonb("required_labels").$type<string[]>().default([]).notNull(),
    updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.taskId, table.projectId],
      foreignColumns: [pacaTasks.id, pacaTasks.projectId],
      name: "paca_agent_task_requirement_task_project_fk",
    }).onDelete("cascade"),
    index("paca_agent_task_requirement_project_idx").on(table.projectId),
    check(
      "paca_agent_task_requirement_labels_check",
      sql`jsonb_typeof(${table.requiredLabels}) = 'array'`,
    ),
  ],
);

export const pacaAgentTaskLeases = pgTable(
  "paca_agent_task_lease",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    taskId: uuid("task_id").notNull(),
    organizationId: text("organization_id").notNull(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    hostId: text("host_id")
      .notNull()
      .references(() => agentHost.id, { onDelete: "cascade" }),
    harnessKind: text("harness_kind").notNull(),
    harnessVersion: text("harness_version"),
    harnessInstanceId: text("harness_instance_id"),
    status: text("status").$type<AgentTaskLeaseStatus>().default("active").notNull(),
    version: integer("version").default(1).notNull(),
    lastCheckpointSequence: integer("last_checkpoint_sequence").default(0).notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    errorCode: text("error_code"),
    resultSummary: text("result_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.taskId, table.projectId],
      foreignColumns: [pacaTasks.id, pacaTasks.projectId],
      name: "paca_agent_task_lease_task_project_fk",
    }).onDelete("cascade"),
    uniqueIndex("paca_agent_task_lease_active_task_uidx")
      .on(table.taskId)
      .where(sql`${table.status} = 'active'`),
    index("paca_agent_task_lease_agent_status_idx").on(
      table.agentId,
      table.status,
      table.updatedAt,
    ),
    index("paca_agent_task_lease_project_status_idx").on(
      table.projectId,
      table.status,
      table.updatedAt,
    ),
    check(
      "paca_agent_task_lease_status_check",
      sql`${table.status} in ('active', 'cancelled', 'completed', 'expired', 'failed')`,
    ),
    check("paca_agent_task_lease_version_check", sql`${table.version} >= 1`),
    check(
      "paca_agent_task_lease_checkpoint_sequence_check",
      sql`${table.lastCheckpointSequence} >= 0`,
    ),
    check(
      "paca_agent_task_lease_finished_check",
      sql`(${table.status} = 'active' and ${table.finishedAt} is null) or (${table.status} <> 'active' and ${table.finishedAt} is not null)`,
    ),
  ],
);

export const pacaAgentTaskLeaseEvents = pgTable(
  "paca_agent_task_lease_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    leaseId: uuid("lease_id")
      .notNull()
      .references(() => pacaAgentTaskLeases.id, { onDelete: "cascade" }),
    requestId: uuid("request_id").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    action: text("action").notNull(),
    actorType: text("actor_type").default("agent").notNull(),
    actorId: text("actor_id"),
    sequence: integer("sequence"),
    checkpointKey: text("checkpoint_key"),
    summary: text("summary"),
    artifactKeys: jsonb("artifact_keys").$type<string[]>().default([]).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("paca_agent_task_lease_event_request_unique").on(table.requestId),
    uniqueIndex("paca_agent_task_lease_event_checkpoint_uidx")
      .on(table.leaseId, table.sequence)
      .where(sql`${table.sequence} is not null`),
    index("paca_agent_task_lease_event_lease_created_idx").on(table.leaseId, table.createdAt),
    check(
      "paca_agent_task_lease_event_action_check",
      sql`${table.action} in ('claim', 'renew', 'checkpoint', 'complete', 'fail', 'cancel_ack', 'cancel_request', 'expire')`,
    ),
    check(
      "paca_agent_task_lease_event_actor_type_check",
      sql`${table.actorType} in ('agent', 'user', 'system')`,
    ),
    check(
      "paca_agent_task_lease_event_sequence_check",
      sql`${table.sequence} is null or ${table.sequence} >= 1`,
    ),
  ],
);

export const pacaTaskLinks = pgTable(
  "paca_task_link",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    sourceTaskId: uuid("source_task_id").notNull(),
    targetTaskId: uuid("target_task_id").notNull(),
    linkType: text("link_type").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.sourceTaskId, table.projectId],
      foreignColumns: [pacaTasks.id, pacaTasks.projectId],
      name: "paca_task_link_source_project_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.targetTaskId, table.projectId],
      foreignColumns: [pacaTasks.id, pacaTasks.projectId],
      name: "paca_task_link_target_project_fk",
    }).onDelete("cascade"),
    unique("paca_task_link_pair_type_unique").on(
      table.sourceTaskId,
      table.targetTaskId,
      table.linkType,
    ),
    index("paca_task_link_project_source_idx").on(table.projectId, table.sourceTaskId),
    index("paca_task_link_project_target_idx").on(table.projectId, table.targetTaskId),
    check(
      "paca_task_link_type_check",
      sql`${table.linkType} in ('blocks', 'relates_to', 'duplicates')`,
    ),
    check("paca_task_link_no_self_check", sql`${table.sourceTaskId} <> ${table.targetTaskId}`),
  ],
);

export const pacaFiles = pgTable(
  "paca_file",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => pacaProjects.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").notNull(),
    storageKey: text("storage_key").notNull(),
    bucket: text("bucket").notNull(),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    declaredSize: bigint("declared_size", { mode: "number" }).notNull(),
    actualSize: bigint("actual_size", { mode: "number" }),
    sha256: text("sha256"),
    etag: text("etag"),
    uploadStatus: text("upload_status").default("pending").notNull(),
    multipartUploadId: text("multipart_upload_id"),
    uploadedBy: text("uploaded_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    purgeStartedAt: timestamp("purge_started_at", { withTimezone: true }),
  },
  (table) => [
    unique("paca_file_id_project_task_unique").on(table.id, table.projectId, table.taskId),
    uniqueIndex("paca_file_storage_key_uidx").on(table.storageKey),
    foreignKey({
      columns: [table.taskId, table.projectId],
      foreignColumns: [pacaTasks.id, pacaTasks.projectId],
      name: "paca_file_task_project_fk",
    }).onDelete("cascade"),
    index("paca_file_project_task_idx").on(table.projectId, table.taskId, table.createdAt),
    index("paca_file_pending_idx")
      .on(table.createdAt)
      .where(sql`${table.uploadStatus} <> 'uploaded'`),
    check(
      "paca_file_upload_status_check",
      sql`${table.uploadStatus} in ('pending', 'uploaded', 'failed')`,
    ),
    check(
      "paca_file_declared_size_check",
      sql`${table.declaredSize} > 0 and ${table.declaredSize} <= 536870912`,
    ),
    check(
      "paca_file_actual_size_check",
      sql`${table.actualSize} is null or ${table.actualSize} = ${table.declaredSize}`,
    ),
    check(
      "paca_file_completed_metadata_check",
      sql`(${table.uploadStatus} = 'uploaded' and ${table.actualSize} is not null and ${table.sha256} is not null and ${table.etag} is not null and ${table.completedAt} is not null and ${table.multipartUploadId} is null) or (${table.uploadStatus} <> 'uploaded' and ${table.completedAt} is null)`,
    ),
  ],
);

export const pacaTaskAttachments = pgTable(
  "paca_task_attachment",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    taskId: uuid("task_id").notNull(),
    fileId: uuid("file_id").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    purgeAfter: timestamp("purge_after", { withTimezone: true }),
    purgeStartedAt: timestamp("purge_started_at", { withTimezone: true }),
  },
  (table) => [
    unique("paca_task_attachment_task_file_unique").on(table.taskId, table.fileId),
    foreignKey({
      columns: [table.taskId, table.projectId],
      foreignColumns: [pacaTasks.id, pacaTasks.projectId],
      name: "paca_task_attachment_task_project_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.fileId, table.projectId, table.taskId],
      foreignColumns: [pacaFiles.id, pacaFiles.projectId, pacaFiles.taskId],
      name: "paca_task_attachment_file_scope_fk",
    }).onDelete("cascade"),
    index("paca_task_attachment_task_created_idx")
      .on(table.taskId, table.createdAt)
      .where(sql`${table.deletedAt} is null`),
    index("paca_task_attachment_file_idx").on(table.fileId),
    index("paca_task_attachment_purge_due_idx")
      .on(table.purgeAfter)
      .where(sql`${table.deletedAt} is not null`),
    check(
      "paca_task_attachment_retention_check",
      sql`(${table.deletedAt} is null and ${table.purgeAfter} is null and ${table.purgeStartedAt} is null) or (${table.deletedAt} is not null and ${table.purgeAfter} is not null)`,
    ),
  ],
);

export const pacaAttachmentMigrationItems = pgTable(
  "paca_attachment_migration_item",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id").notNull(),
    sourceBucket: text("source_bucket").notNull(),
    sourceKey: text("source_key").notNull(),
    sourceFileId: uuid("source_file_id").notNull(),
    sourceAttachmentId: uuid("source_attachment_id").notNull(),
    targetFileId: uuid("target_file_id").notNull(),
    targetAttachmentId: uuid("target_attachment_id").notNull(),
    targetBucket: text("target_bucket").notNull(),
    targetStorageKey: text("target_storage_key").notNull(),
    sourceSize: bigint("source_size", { mode: "number" }).notNull(),
    sha256: text("sha256"),
    targetEtag: text("target_etag"),
    status: text("status").default("planned").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    ownsTargetObject: boolean("owns_target_object").default(false).notNull(),
    ownsTargetFile: boolean("owns_target_file").default(false).notNull(),
    ownsTargetAttachment: boolean("owns_target_attachment").default(false).notNull(),
    errorCode: text("error_code"),
    rollbackStartedAt: timestamp("rollback_started_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("paca_attachment_migration_run_source_unique").on(table.runId, table.sourceAttachmentId),
    uniqueIndex("paca_attachment_migration_active_source_uidx")
      .on(table.sourceAttachmentId)
      .where(sql`${table.status} <> 'rolled_back'`),
    index("paca_attachment_migration_run_status_idx").on(table.runId, table.status),
    index("paca_attachment_migration_target_idx").on(table.targetAttachmentId, table.targetFileId),
    check("paca_attachment_migration_source_size_check", sql`${table.sourceSize} > 0`),
    check(
      "paca_attachment_migration_status_check",
      sql`${table.status} in ('planned', 'copied', 'imported', 'rollback_started', 'rolled_back', 'failed')`,
    ),
    check("paca_attachment_migration_attempts_check", sql`${table.attempts} >= 0`),
  ],
);

export const pacaViewTaskPositions = pgTable(
  "paca_view_task_position",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    viewId: uuid("view_id").notNull(),
    taskId: uuid("task_id").notNull(),
    projectId: uuid("project_id").notNull(),
    position: doublePrecision("position").default(0).notNull(),
    groupKey: text("group_key"),
  },
  (table) => [
    unique("paca_view_task_position_view_task_unique").on(table.viewId, table.taskId),
    foreignKey({
      columns: [table.viewId, table.projectId],
      foreignColumns: [pacaTaskViews.id, pacaTaskViews.projectId],
      name: "paca_view_task_position_view_project_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.taskId, table.projectId],
      foreignColumns: [pacaTasks.id, pacaTasks.projectId],
      name: "paca_view_task_position_task_project_fk",
    }).onDelete("cascade"),
    index("paca_view_task_position_view_position_idx").on(table.viewId, table.position),
    index("paca_view_task_position_task_idx").on(table.taskId),
  ],
);

export const pacaTaskAssignees = pgTable(
  "paca_task_assignee",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => pacaTasks.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => pacaProjectMembers.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => pacaProjects.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.memberId] }),
    index("paca_task_assignee_member_idx").on(table.memberId),
    index("paca_task_assignee_project_idx").on(table.projectId),
  ],
);

export const pacaTaskActivities = pgTable(
  "paca_task_activity",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    taskId: uuid("task_id").notNull(),
    projectId: uuid("project_id").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    actorAgentId: text("actor_agent_id").references(() => agent.id, { onDelete: "set null" }),
    actorMemberId: uuid("actor_member_id").references(() => pacaProjectMembers.id, {
      onDelete: "set null",
    }),
    activityType: text("activity_type").notNull(),
    content: jsonb("content").$type<Record<string, unknown> | unknown[]>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.taskId, table.projectId],
      foreignColumns: [pacaTasks.id, pacaTasks.projectId],
      name: "paca_task_activity_task_project_fk",
    }).onDelete("cascade"),
    index("paca_task_activity_task_created_idx").on(table.taskId, table.createdAt),
    index("paca_task_activity_project_created_idx").on(table.projectId, table.createdAt),
    index("paca_task_activity_actor_created_idx").on(
      table.actorType,
      table.actorId,
      table.createdAt,
    ),
    index("paca_task_activity_actor_user_idx")
      .on(table.actorUserId, table.createdAt)
      .where(sql`${table.actorUserId} is not null`),
    index("paca_task_activity_actor_agent_idx")
      .on(table.actorAgentId, table.createdAt)
      .where(sql`${table.actorAgentId} is not null`),
    check(
      "paca_task_activity_actor_type_check",
      sql`${table.actorType} in ('user', 'agent', 'system')`,
    ),
    check(
      "paca_task_activity_actor_identity_check",
      sql`(${table.actorType} = 'user' and ${table.actorAgentId} is null and (${table.actorUserId} is null or ${table.actorUserId} = ${table.actorId})) or (${table.actorType} = 'agent' and ${table.actorUserId} is null and ${table.actorMemberId} is null and (${table.actorAgentId} is null or ${table.actorAgentId} = ${table.actorId})) or (${table.actorType} = 'system' and ${table.actorId} = 'system' and ${table.actorUserId} is null and ${table.actorAgentId} is null and ${table.actorMemberId} is null)`,
    ),
  ],
);

/**
 * Queryable document projection. The canonical collaborative Yjs state lives in
 * DocumentParty; `content` is the materialized BlockNote JSON view used by list,
 * search, exports, history and non-collaborative compatibility reads.
 */
export const pacaDocuments = pgTable(
  "paca_document",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => pacaProjects.id, { onDelete: "cascade" }),
    title: text("title").default("Untitled").notNull(),
    content: jsonb("content").$type<unknown[] | null>(),
    contentVersion: bigint("content_version", { mode: "number" }).default(0).notNull(),
    yjsRevision: bigint("yjs_revision", { mode: "number" }).default(0).notNull(),
    yjsSnapshotKey: text("yjs_snapshot_key"),
    yjsSnapshotSha256: text("yjs_snapshot_sha256"),
    yjsSnapshotBytes: bigint("yjs_snapshot_bytes", { mode: "number" }),
    yjsSnapshotAt: timestamp("yjs_snapshot_at", { withTimezone: true }),
    position: integer("position").default(0).notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("paca_document_project_position_idx").on(table.projectId, table.position, table.title),
    index("paca_document_deleted_idx")
      .on(table.deletedAt)
      .where(sql`${table.deletedAt} is not null`),
    check("paca_document_content_version_check", sql`${table.contentVersion} >= 0`),
    check("paca_document_yjs_revision_check", sql`${table.yjsRevision} >= 0`),
    check(
      "paca_document_yjs_snapshot_bytes_check",
      sql`${table.yjsSnapshotBytes} is null or ${table.yjsSnapshotBytes} >= 0`,
    ),
  ],
);

export type RealtimeOutboxStatus = "pending" | "enqueuing" | "enqueued" | "delivered";

export const pacaRealtimeOutbox = pgTable(
  "paca_realtime_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    roomType: text("room_type").notNull(),
    roomId: text("room_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").$type<RealtimeOutboxStatus>().default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("paca_realtime_outbox_dispatch_idx").on(table.status, table.availableAt, table.createdAt),
    index("paca_realtime_outbox_room_idx").on(table.roomType, table.roomId, table.createdAt),
    check("paca_realtime_outbox_room_type_check", sql`${table.roomType} in ('project', 'user')`),
    check(
      "paca_realtime_outbox_status_check",
      sql`${table.status} in ('pending', 'enqueuing', 'enqueued', 'delivered')`,
    ),
    check("paca_realtime_outbox_attempts_check", sql`${table.attempts} >= 0`),
  ],
);

export const pacaProjectsRelations = relations(pacaProjects, ({ one, many }) => ({
  organization: one(organization, {
    fields: [pacaProjects.organizationId],
    references: [organization.id],
  }),
  creator: one(user, {
    fields: [pacaProjects.createdBy],
    references: [user.id],
  }),
  roles: many(pacaProjectRoles),
  members: many(pacaProjectMembers),
  documents: many(pacaDocuments),
}));

export const pacaDocumentsRelations = relations(pacaDocuments, ({ one }) => ({
  project: one(pacaProjects, {
    fields: [pacaDocuments.projectId],
    references: [pacaProjects.id],
  }),
  creator: one(user, {
    fields: [pacaDocuments.createdBy],
    references: [user.id],
    relationName: "paca_document_creator",
  }),
  updater: one(user, {
    fields: [pacaDocuments.updatedBy],
    references: [user.id],
    relationName: "paca_document_updater",
  }),
}));

export const pacaProjectRolesRelations = relations(pacaProjectRoles, ({ one, many }) => ({
  project: one(pacaProjects, {
    fields: [pacaProjectRoles.projectId],
    references: [pacaProjects.id],
  }),
  permissions: many(pacaRolePermissions),
  memberRoles: many(pacaProjectMemberRoles),
}));

export const pacaRolePermissionsRelations = relations(pacaRolePermissions, ({ one }) => ({
  role: one(pacaProjectRoles, {
    fields: [pacaRolePermissions.roleId],
    references: [pacaProjectRoles.id],
  }),
}));

export const pacaProjectMembersRelations = relations(pacaProjectMembers, ({ one, many }) => ({
  project: one(pacaProjects, {
    fields: [pacaProjectMembers.projectId],
    references: [pacaProjects.id],
  }),
  user: one(user, {
    fields: [pacaProjectMembers.userId],
    references: [user.id],
  }),
  memberRoles: many(pacaProjectMemberRoles),
}));

export const pacaProjectMemberRolesRelations = relations(pacaProjectMemberRoles, ({ one }) => ({
  member: one(pacaProjectMembers, {
    fields: [pacaProjectMemberRoles.memberId],
    references: [pacaProjectMembers.id],
  }),
  role: one(pacaProjectRoles, {
    fields: [pacaProjectMemberRoles.roleId],
    references: [pacaProjectRoles.id],
  }),
  project: one(pacaProjects, {
    fields: [pacaProjectMemberRoles.projectId],
    references: [pacaProjects.id],
  }),
}));

export const pacaSystemRolesRelations = relations(pacaSystemRoles, ({ many }) => ({
  permissions: many(pacaSystemRolePermissions),
  userRoles: many(pacaUserSystemRoles),
}));

export const pacaSystemRolePermissionsRelations = relations(
  pacaSystemRolePermissions,
  ({ one }) => ({
    role: one(pacaSystemRoles, {
      fields: [pacaSystemRolePermissions.roleId],
      references: [pacaSystemRoles.id],
    }),
  }),
);

export const pacaUserSystemRolesRelations = relations(pacaUserSystemRoles, ({ one }) => ({
  user: one(user, {
    fields: [pacaUserSystemRoles.userId],
    references: [user.id],
  }),
  role: one(pacaSystemRoles, {
    fields: [pacaUserSystemRoles.roleId],
    references: [pacaSystemRoles.id],
  }),
}));

export const pacaOrganizationRolesRelations = relations(pacaOrganizationRoles, ({ one, many }) => ({
  organization: one(organization, {
    fields: [pacaOrganizationRoles.organizationId],
    references: [organization.id],
  }),
  permissions: many(pacaOrganizationRolePermissions),
  memberRoles: many(pacaOrganizationMemberRoles),
}));

export const pacaOrganizationRolePermissionsRelations = relations(
  pacaOrganizationRolePermissions,
  ({ one }) => ({
    role: one(pacaOrganizationRoles, {
      fields: [pacaOrganizationRolePermissions.roleId],
      references: [pacaOrganizationRoles.id],
    }),
  }),
);

export const pacaOrganizationMemberRolesRelations = relations(
  pacaOrganizationMemberRoles,
  ({ one }) => ({
    member: one(member, {
      fields: [pacaOrganizationMemberRoles.memberId],
      references: [member.id],
    }),
    role: one(pacaOrganizationRoles, {
      fields: [pacaOrganizationMemberRoles.roleId],
      references: [pacaOrganizationRoles.id],
    }),
    organization: one(organization, {
      fields: [pacaOrganizationMemberRoles.organizationId],
      references: [organization.id],
    }),
  }),
);
