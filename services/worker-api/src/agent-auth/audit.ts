import type { AgentAuthEvent } from "@better-auth/agent-auth";

import type { PacaDatabase } from "../database";
import { pacaAgentAuthAudit } from "../db/schema";

const REDACTED_KEY = /(authorization|password|secret|token|private|code|key)/i;
const POSTGRES_CODE = /^[0-9A-Z]{5}$/;
const POSTGRES_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export type AgentAuthAuditFailure = {
  event: "agent.auth.audit.failed";
  eventType: AgentAuthEvent["type"];
  postgresCode?: string;
  constraint?: string;
  table?: string;
};

type AuditFailureLogger = (failure: AgentAuthAuditFailure) => void;

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 3) return "[truncated]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 1_000);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
  if (typeof value !== "object") return String(value);

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .map(([key, item]) => [
        key,
        REDACTED_KEY.test(key) ? "[redacted]" : sanitize(item, depth + 1),
      ]),
  );
}

function safePostgresField(error: unknown, field: "constraint" | "table"): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" && POSTGRES_IDENTIFIER.test(value) ? value : undefined;
}

export function describeAgentAuthAuditFailure(
  error: unknown,
  eventType: AgentAuthEvent["type"],
): AgentAuthAuditFailure {
  const rawCode =
    error && typeof error === "object" ? (error as Record<string, unknown>).code : undefined;
  return {
    event: "agent.auth.audit.failed",
    eventType,
    ...(typeof rawCode === "string" && POSTGRES_CODE.test(rawCode)
      ? { postgresCode: rawCode }
      : {}),
    ...(safePostgresField(error, "constraint")
      ? { constraint: safePostgresField(error, "constraint") }
      : {}),
    ...(safePostgresField(error, "table") ? { table: safePostgresField(error, "table") } : {}),
  };
}

export async function recordAgentAuthEvent(
  database: PacaDatabase,
  event: AgentAuthEvent,
  logFailure: AuditFailureLogger = (failure) => console.error(JSON.stringify(failure)),
) {
  const execution = event.type === "capability.executed" ? event : null;
  const metadata = {
    ...(event.metadata ? (sanitize(event.metadata) as Record<string, unknown>) : {}),
    ...(execution
      ? {
          provider: execution.provider,
          agentName: execution.agentName,
          argumentKeys: Object.keys(execution.arguments ?? {}).sort(),
          outputType: execution.output === null ? "null" : typeof execution.output,
          error: execution.error?.slice(0, 1_000),
        }
      : {}),
  };

  try {
    await database.insert(pacaAgentAuthAudit).values({
      id: crypto.randomUUID(),
      eventType: event.type,
      actorType: event.actorType ?? "system",
      actorId: event.actorId ?? execution?.userId ?? null,
      agentId: event.agentId ?? null,
      hostId: event.hostId ?? null,
      targetType: event.targetType ?? null,
      targetId: event.targetId ?? null,
      capability: execution?.capability ?? null,
      executionStatus: execution?.status ?? null,
      durationMs: execution?.durationMs ?? null,
      metadata,
    });
  } catch (error) {
    logFailure(describeAgentAuthAuditFailure(error, event.type));
    throw error;
  }
}
