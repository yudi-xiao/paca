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
  it("records document execution scope without copying document content", async () => {
    const values = vi.fn(async (_value: Record<string, unknown>) => undefined);
    const database = {
      insert: vi.fn(() => ({ values })),
    } as unknown as PacaDatabase;
    const execution: AgentAuthEvent = {
      type: "capability.executed",
      capability: "document.edit",
      actorType: "agent",
      actorId: "agent-1",
      agentId: "agent-1",
      status: "success",
      arguments: {
        organizationId: "paca-default",
        projectId: "11111111-1111-4111-8111-111111111111",
        documentId: "44444444-4444-4444-8444-444444444444",
        field: "block.content",
        operationMode: "collaborate",
        action: "apply",
        requestId: "55555555-5555-4555-8555-555555555555",
        runId: "66666666-6666-4666-8666-666666666666",
        baseRevision: 7,
        baseStateVector: "must-not-be-copied",
        operations: [
          {
            type: "replace_block_content",
            blockId: "block-a",
            expectedBlockVersion: "must-not-be-copied",
            content: [{ type: "text", text: "private draft" }],
          },
        ],
      },
      output: { applied: true },
    };

    await recordAgentAuthEvent(database, execution);
    const recorded = values.mock.calls[0]?.[0];
    expect(recorded).toMatchObject({
      capability: "document.edit",
      executionStatus: "success",
      metadata: {
        executionScope: {
          organizationId: "paca-default",
          projectId: "11111111-1111-4111-8111-111111111111",
          documentId: "44444444-4444-4444-8444-444444444444",
          field: "block.content",
          operationMode: "collaborate",
          action: "apply",
          requestId: "55555555-5555-4555-8555-555555555555",
          runId: "66666666-6666-4666-8666-666666666666",
          baseRevision: 7,
          operationCount: 1,
          operationTargets: [{ type: "replace_block_content", blockId: "block-a" }],
        },
      },
    });
    expect(JSON.stringify(recorded)).not.toMatch(/private draft|must-not-be-copied/);
  });

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
