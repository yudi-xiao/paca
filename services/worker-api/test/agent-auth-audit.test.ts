import type { AgentAuthEvent } from "@better-auth/agent-auth";
import { describe, expect, it, vi } from "vitest";

import { describeAgentAuthAuditFailure, recordAgentAuthEvent } from "../src/agent-auth/audit";
import type { PacaDatabase } from "../src/database";

const event: AgentAuthEvent = {
  type: "capability.revoked",
  actorType: "user",
  actorId: "user-1",
  agentId: "agent-1",
};

function databaseThatFails(error: unknown): PacaDatabase {
  return {
    insert: vi.fn(() => ({
      values: vi.fn(async () => {
        throw error;
      }),
    })),
  } as unknown as PacaDatabase;
}

describe("Agent Auth audit failures", () => {
  it("keeps only safe PostgreSQL diagnostics and rejects arbitrary error text", () => {
    const failure = describeAgentAuthAuditFailure(
      {
        code: "42501",
        constraint: "paca_agent_auth_audit_event_type_check",
        table: "paca_agent_auth_audit",
        message: "password=do-not-log postgresql://operator:secret@example.invalid/paca",
        detail: "INSERT contained an Agent private key",
      },
      event.type,
    );

    expect(failure).toEqual({
      event: "agent.auth.audit.failed",
      eventType: "capability.revoked",
      postgresCode: "42501",
      constraint: "paca_agent_auth_audit_event_type_check",
      table: "paca_agent_auth_audit",
    });
    expect(JSON.stringify(failure)).not.toMatch(/password|secret|postgresql|private key/i);
  });

  it("omits malformed diagnostics, logs once, and rethrows the original failure", async () => {
    const error = {
      code: "ECONNRESET",
      constraint: "unsafe constraint; select secret",
      table: "paca_agent_auth_audit --",
      message: "must not be logged",
    };
    const logger = vi.fn();

    await expect(recordAgentAuthEvent(databaseThatFails(error), event, logger)).rejects.toBe(error);
    expect(logger).toHaveBeenCalledOnce();
    expect(logger).toHaveBeenCalledWith({
      event: "agent.auth.audit.failed",
      eventType: "capability.revoked",
    });
  });
});
