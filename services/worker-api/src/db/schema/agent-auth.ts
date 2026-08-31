import { index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * PostgreSQL-backed Better Auth secondary storage. Agent JWT replay keys use
 * insert-only semantics in the adapter; other Better Auth cache/rate-limit
 * keys can be replaced or incremented atomically.
 */
export const pacaAuthSecondaryStorage = pgTable(
  "paca_auth_secondary_storage",
  {
    key: text("key").primaryKey(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("paca_auth_secondary_storage_expiry_idx").on(table.expiresAt)],
);

export const pacaAgentAuthAudit = pgTable(
  "paca_agent_auth_audit",
  {
    id: text("id").primaryKey(),
    eventType: text("event_type").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    agentId: text("agent_id"),
    hostId: text("host_id"),
    targetType: text("target_type"),
    targetId: text("target_id"),
    capability: text("capability"),
    executionStatus: text("execution_status"),
    durationMs: integer("duration_ms"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("paca_agent_auth_audit_created_idx").on(table.createdAt),
    index("paca_agent_auth_audit_agent_created_idx").on(table.agentId, table.createdAt),
    index("paca_agent_auth_audit_actor_created_idx").on(table.actorId, table.createdAt),
  ],
);
