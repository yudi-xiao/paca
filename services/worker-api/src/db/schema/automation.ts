import { sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { user } from "./auth";
import { pacaProjects } from "./paca";

export type PacaAutomationStatus = "active" | "inactive";
export type PacaAutomationNodeKind = "trigger" | "condition" | "action";
export type PacaAutomationRunStatus = "running" | "completed" | "failed";
export type PacaAutomationRunStepStatus = "completed" | "failed" | "skipped";

export const pacaAutomations = pgTable(
  "paca_automation",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => pacaProjects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").default("").notNull(),
    status: text("status").$type<PacaAutomationStatus>().default("inactive").notNull(),
    graphVersion: integer("graph_version").default(1).notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    unique("paca_automation_id_project_unique").on(table.id, table.projectId),
    uniqueIndex("paca_automation_project_name_active_uidx")
      .on(table.projectId, sql`lower(${table.name})`)
      .where(sql`${table.deletedAt} is null`),
    index("paca_automation_project_status_idx").on(table.projectId, table.status, table.updatedAt),
    check(
      "paca_automation_name_check",
      sql`${table.name} = btrim(${table.name}) and length(${table.name}) between 1 and 255`,
    ),
    check("paca_automation_status_check", sql`${table.status} in ('active', 'inactive')`),
    check("paca_automation_graph_version_check", sql`${table.graphVersion} >= 1`),
  ],
);

export const pacaAutomationNodes = pgTable(
  "paca_automation_node",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => pacaAutomations.id, { onDelete: "cascade" }),
    kind: text("kind").$type<PacaAutomationNodeKind>().notNull(),
    type: text("type").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().default({}).notNull(),
    posX: doublePrecision("pos_x").default(0).notNull(),
    posY: doublePrecision("pos_y").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("paca_automation_node_id_automation_unique").on(table.id, table.automationId),
    index("paca_automation_node_automation_idx").on(table.automationId, table.createdAt),
    index("paca_automation_node_trigger_type_idx")
      .on(table.type)
      .where(sql`${table.kind} = 'trigger'`),
    check(
      "paca_automation_node_kind_check",
      sql`${table.kind} in ('trigger', 'condition', 'action')`,
    ),
    check(
      "paca_automation_node_type_check",
      sql`${table.type} = btrim(${table.type}) and length(${table.type}) between 1 and 100`,
    ),
    check("paca_automation_node_config_check", sql`jsonb_typeof(${table.config}) = 'object'`),
    check(
      "paca_automation_node_position_check",
      sql`${table.posX} > '-Infinity'::float8 and ${table.posX} < 'Infinity'::float8 and ${table.posY} > '-Infinity'::float8 and ${table.posY} < 'Infinity'::float8`,
    ),
  ],
);

export const pacaAutomationEdges = pgTable(
  "paca_automation_edge",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => pacaAutomations.id, { onDelete: "cascade" }),
    sourceNodeId: uuid("source_node_id").notNull(),
    sourceHandle: text("source_handle"),
    targetNodeId: uuid("target_node_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.sourceNodeId, table.automationId],
      foreignColumns: [pacaAutomationNodes.id, pacaAutomationNodes.automationId],
      name: "paca_automation_edge_source_automation_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.targetNodeId, table.automationId],
      foreignColumns: [pacaAutomationNodes.id, pacaAutomationNodes.automationId],
      name: "paca_automation_edge_target_automation_fk",
    }).onDelete("cascade"),
    uniqueIndex("paca_automation_edge_path_uidx").on(
      table.automationId,
      table.sourceNodeId,
      sql`coalesce(${table.sourceHandle}, '')`,
      table.targetNodeId,
    ),
    index("paca_automation_edge_target_idx").on(table.targetNodeId),
    check("paca_automation_edge_self_check", sql`${table.sourceNodeId} <> ${table.targetNodeId}`),
    check(
      "paca_automation_edge_handle_check",
      sql`${table.sourceHandle} is null or (length(${table.sourceHandle}) between 1 and 100 and ${table.sourceHandle} = btrim(${table.sourceHandle}))`,
    ),
  ],
);

export const pacaAutomationRuns = pgTable(
  "paca_automation_run",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => pacaAutomations.id, { onDelete: "cascade" }),
    triggerNodeId: uuid("trigger_node_id").notNull(),
    taskId: uuid("task_id"),
    eventKey: text("event_key").notNull(),
    graphVersion: integer("graph_version").notNull(),
    graphSnapshot: jsonb("graph_snapshot").$type<Record<string, unknown>>().notNull(),
    status: text("status").$type<PacaAutomationRunStatus>().default("running").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    unique("paca_automation_run_id_automation_unique").on(table.id, table.automationId),
    unique("paca_automation_run_event_unique").on(table.automationId, table.eventKey),
    index("paca_automation_run_automation_started_idx").on(table.automationId, table.startedAt),
    index("paca_automation_run_task_idx").on(table.taskId),
    check("paca_automation_run_event_key_check", sql`length(${table.eventKey}) between 1 and 255`),
    check("paca_automation_run_graph_version_check", sql`${table.graphVersion} >= 1`),
    check(
      "paca_automation_run_snapshot_check",
      sql`jsonb_typeof(${table.graphSnapshot}) = 'object'`,
    ),
    check(
      "paca_automation_run_status_check",
      sql`${table.status} in ('running', 'completed', 'failed')`,
    ),
  ],
);

export const pacaAutomationRunSteps = pgTable(
  "paca_automation_run_step",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => pacaAutomationRuns.id, { onDelete: "cascade" }),
    nodeId: uuid("node_id").notNull(),
    stepKey: text("step_key").notNull(),
    status: text("status").$type<PacaAutomationRunStepStatus>().notNull(),
    inputSnapshot: jsonb("input_snapshot").$type<Record<string, unknown> | null>(),
    outputSnapshot: jsonb("output_snapshot").$type<Record<string, unknown> | null>(),
    errorCode: text("error_code"),
    executedAt: timestamp("executed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("paca_automation_run_step_key_unique").on(table.runId, table.stepKey),
    index("paca_automation_run_step_run_executed_idx").on(table.runId, table.executedAt),
    check("paca_automation_run_step_key_check", sql`length(${table.stepKey}) between 1 and 255`),
    check(
      "paca_automation_run_step_status_check",
      sql`${table.status} in ('completed', 'failed', 'skipped')`,
    ),
  ],
);
