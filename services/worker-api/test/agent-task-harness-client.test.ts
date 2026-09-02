import { describe, expect, it, vi } from "vitest";

import {
  AgentTaskHarnessClient,
  AgentTaskHarnessProtocolError,
  type AgentTaskHarnessTransport,
} from "../src/agent-task/harness-client";
import type { AgentTaskLeaseCommand } from "../src/agent-task/protocol";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const LEASE_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const VALID_UNTIL = "2026-09-02T04:00:00.000Z";
const scope = {
  organizationId: "paca-default",
  projectId: PROJECT_ID,
  taskId: TASK_ID,
  validUntil: VALID_UNTIL,
};

function result(command: AgentTaskLeaseCommand) {
  return {
    data: {
      duplicate: false,
      lease: {
        id: LEASE_ID,
        organizationId: command.organizationId,
        projectId: command.projectId,
        taskId: command.taskId,
        agentId: "agent-1",
        hostId: "host-1",
        harness:
          command.action === "claim"
            ? {
                kind: command.harness.kind,
                version: command.harness.version ?? null,
                instanceId: command.harness.instanceId ?? null,
              }
            : { kind: "codex", version: "1.0.0", instanceId: "local-1" },
        status: command.action === "complete" ? "completed" : "active",
        version: command.action === "complete" ? 2 : 1,
        lastCheckpointSequence: command.action === "checkpoint" ? command.sequence : 0,
        leaseExpiresAt: "2026-09-02T03:31:00.000Z",
        claimedAt: "2026-09-02T03:30:00.000Z",
        finishedAt: command.action === "complete" ? "2026-09-02T03:30:30.000Z" : null,
        errorCode: null,
        resultSummary: null,
        createdAt: "2026-09-02T03:30:00.000Z",
        updatedAt: "2026-09-02T03:30:00.000Z",
      },
    },
  };
}

function client() {
  const execute = vi.fn(async (command: AgentTaskLeaseCommand) => result(command));
  const discover = vi.fn(async () => ({
    data: [
      {
        organization_id: "paca-default",
        project_id: PROJECT_ID,
        task_id: TASK_ID,
        task_number: 1,
        title: "Claimable task",
        status_id: null,
        task_updated_at: "2026-09-02T03:30:00.000Z",
        valid_until: VALID_UNTIL,
        availability: "claimable",
        lease: null,
      },
    ],
  }));
  const transport: AgentTaskHarnessTransport = { execute, discover };
  return {
    discover,
    execute,
    client: new AgentTaskHarnessClient(transport, {
      kind: "codex",
      version: "1.0.0",
      instanceId: "local-1",
    }),
  };
}

describe("runtime-independent Agent task Harness client", () => {
  it("builds the same bounded command contract and decodes wire dates", async () => {
    const harness = client();
    const claimed = await harness.client.claim(scope, {
      requestId: REQUEST_ID,
      leaseDurationMs: 60_000,
    });
    expect(claimed.lease.harness).toEqual({
      kind: "codex",
      version: "1.0.0",
      instanceId: "local-1",
    });
    expect(claimed.lease.leaseExpiresAt).toBeInstanceOf(Date);
    expect(harness.execute).toHaveBeenCalledWith({
      ...scope,
      operationMode: "execute",
      requestId: REQUEST_ID,
      action: "claim",
      leaseDurationMs: 60_000,
      harness: { kind: "codex", version: "1.0.0", instanceId: "local-1" },
    });

    await expect(
      harness.client.complete(scope, {
        leaseId: LEASE_ID,
        requestId: "55555555-5555-4555-8555-555555555555",
        summary: "done",
      }),
    ).resolves.toMatchObject({ lease: { status: "completed" } });
  });

  it("preserves caller request IDs so an exact retry remains idempotent", async () => {
    const harness = client();
    const input = { requestId: REQUEST_ID, leaseDurationMs: 60_000 };
    await harness.client.claim(scope, input);
    await harness.client.claim(scope, input);
    expect(harness.execute.mock.calls[0]?.[0]).toEqual(harness.execute.mock.calls[1]?.[0]);
  });

  it("discovers approved work and decodes task timestamps", async () => {
    const harness = client();
    const tasks = await harness.client.discover();

    expect(tasks).toEqual([
      expect.objectContaining({
        task_id: TASK_ID,
        availability: "claimable",
        task_updated_at: new Date("2026-09-02T03:30:00.000Z"),
      }),
    ]);
    expect(harness.discover).toHaveBeenCalledOnce();
  });

  it("rejects malformed output and a claim that changes the configured Harness identity", async () => {
    const malformed = new AgentTaskHarnessClient(
      { execute: async () => ({ unexpected: true }) },
      { kind: "codex" },
    );
    await expect(
      malformed.claim(scope, { requestId: REQUEST_ID, leaseDurationMs: 60_000 }),
    ).rejects.toEqual(new AgentTaskHarnessProtocolError("AGENT_TASK_HARNESS_RESULT_INVALID"));

    const harness = client();
    await expect(
      harness.client.execute({
        ...scope,
        operationMode: "execute",
        requestId: REQUEST_ID,
        action: "claim",
        leaseDurationMs: 60_000,
        harness: { kind: "claude-code" },
      }),
    ).rejects.toEqual(new AgentTaskHarnessProtocolError("AGENT_TASK_HARNESS_INPUT_INVALID"));
    expect(harness.execute).not.toHaveBeenCalled();
  });
});
