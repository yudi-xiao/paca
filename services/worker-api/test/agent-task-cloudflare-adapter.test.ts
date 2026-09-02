import { describe, expect, it, vi } from "vitest";

import { hostedTaskLeaseMirror, mirrorHostedTaskLease } from "../src/agent-task/cloudflare-adapter";
import type { AgentTaskLeaseCommand, AgentTaskLeaseResult } from "../src/agent-task/protocol";

const NOW = new Date("2026-09-02T08:00:00.000Z");
const command = {
  organizationId: "paca-default",
  projectId: "11111111-1111-4111-8111-111111111111",
  taskId: "22222222-2222-4222-8222-222222222222",
  operationMode: "execute",
  validUntil: "2026-09-02T09:00:00.000Z",
  requestId: "33333333-3333-4333-8333-333333333333",
  action: "claim",
  leaseDurationMs: 30_000,
  harness: { kind: "cloudflare-agent" },
} as const satisfies AgentTaskLeaseCommand;

function result(kind: "cloudflare-agent" | "codex" = "cloudflare-agent"): AgentTaskLeaseResult {
  return {
    duplicate: false,
    lease: {
      id: "44444444-4444-4444-8444-444444444444",
      organizationId: "paca-default",
      projectId: command.projectId,
      taskId: command.taskId,
      agentId: "agent-1",
      hostId: "host-1",
      harness: { kind, version: null, instanceId: null },
      status: "active",
      version: 1,
      lastCheckpointSequence: 0,
      leaseExpiresAt: new Date(NOW.getTime() + 30_000),
      claimedAt: NOW,
      finishedAt: null,
      errorCode: null,
      resultSummary: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

describe("Cloudflare Agent task adapter", () => {
  it("creates only a bounded lease mirror without credentials or task content", () => {
    const mirror = hostedTaskLeaseMirror(command, result());
    expect(mirror).toMatchObject({
      requestId: command.requestId,
      agentId: "agent-1",
      harnessKind: "cloudflare-agent",
      status: "active",
      version: 1,
    });
    expect(Object.keys(mirror ?? {}).sort()).toEqual(
      [
        "agentId",
        "errorCode",
        "finishedAt",
        "harnessKind",
        "hostId",
        "lastCheckpointSequence",
        "leaseExpiresAt",
        "leaseId",
        "organizationId",
        "projectId",
        "requestId",
        "status",
        "taskId",
        "updatedAt",
        "version",
      ].sort(),
    );
    expect(JSON.stringify(mirror)).not.toMatch(/jwt|grant|token|description|summary/i);
  });

  it("dispatches Cloudflare leases to the Agent keyed by Better Auth Agent ID", async () => {
    const mirroredLease = hostedTaskLeaseMirror(command, result());
    if (!mirroredLease) throw new Error("expected a hosted lease mirror");
    const recordTaskLease = vi.fn(async () => ({
      success: true as const,
      duplicate: false,
      lease: mirroredLease,
    }));
    const getByName = vi.fn(() => ({ recordTaskLease }));

    await mirrorHostedTaskLease({ AgentCoordinator: { getByName } } as never, command, result());

    expect(getByName).toHaveBeenCalledWith("agent-1");
    expect(recordTaskLease).toHaveBeenCalledOnce();
  });

  it("does not route local Harness leases into an AgentDO", async () => {
    const getByName = vi.fn();
    await mirrorHostedTaskLease(
      { AgentCoordinator: { getByName } } as never,
      command,
      result("codex"),
    );
    expect(getByName).not.toHaveBeenCalled();
  });
});
