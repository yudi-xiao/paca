import { describe, expect, it, vi } from "vitest";

import type { AgentTaskLease } from "../src/agent-task/protocol";
import {
  AgentTaskLeaseError,
  type AgentTaskLeaseRepository,
  AgentTaskLeaseService,
  agentTaskLeaseErrorCodes,
} from "../src/agent-task/service";

const NOW = new Date("2026-09-02T03:00:00.000Z");
const AUTHORIZATION_EXPIRY = new Date("2026-09-02T03:10:00.000Z");
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";

const lease: AgentTaskLease = {
  id: "44444444-4444-4444-8444-444444444444",
  organizationId: "paca-default",
  projectId: PROJECT_ID,
  taskId: TASK_ID,
  agentId: "agent-1",
  hostId: "host-1",
  harness: { kind: "codex", version: "1.0.0", instanceId: "local-mac" },
  status: "active",
  version: 1,
  lastCheckpointSequence: 0,
  leaseExpiresAt: new Date("2026-09-02T03:01:00.000Z"),
  claimedAt: NOW,
  finishedAt: null,
  errorCode: null,
  resultSummary: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function claimCommand() {
  return {
    organizationId: "paca-default",
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    operationMode: "execute" as const,
    validUntil: AUTHORIZATION_EXPIRY.toISOString(),
    requestId: REQUEST_ID,
    action: "claim" as const,
    leaseDurationMs: 60_000,
    harness: { kind: "codex" as const, version: "1.0.0", instanceId: "local-mac" },
  };
}

describe("Agent task lease service contract", () => {
  it("passes one normalized command and trusted Agent/Host identity to the repository", async () => {
    const execute = vi.fn(async () => ({ duplicate: false, lease }));
    const repository: AgentTaskLeaseRepository = { execute };
    const service = new AgentTaskLeaseService(repository);

    await expect(
      service.execute(
        { agentId: "agent-1", hostId: "host-1" },
        claimCommand(),
        AUTHORIZATION_EXPIRY,
        NOW,
      ),
    ).resolves.toEqual({ duplicate: false, lease });
    expect(execute).toHaveBeenCalledWith({
      actor: { agentId: "agent-1", hostId: "host-1" },
      command: claimCommand(),
      authorizationExpiresAt: AUTHORIZATION_EXPIRY,
      now: NOW,
    });
  });

  it("rejects unknown Harness kinds, unsafe artifact keys, and expired authorization", async () => {
    const repository: AgentTaskLeaseRepository = { execute: vi.fn() };
    const service = new AgentTaskLeaseService(repository);

    await expect(
      service.execute(
        { agentId: "agent-1", hostId: "host-1" },
        { ...claimCommand(), harness: { kind: "untrusted-shell" } },
        AUTHORIZATION_EXPIRY,
        NOW,
      ),
    ).rejects.toEqual(new AgentTaskLeaseError(agentTaskLeaseErrorCodes.inputInvalid));
    await expect(
      service.execute(
        { agentId: "agent-1", hostId: "host-1" },
        {
          ...claimCommand(),
          action: "checkpoint",
          leaseId: lease.id,
          sequence: 1,
          artifactKeys: ["../database-secret"],
        },
        AUTHORIZATION_EXPIRY,
        NOW,
      ),
    ).rejects.toEqual(new AgentTaskLeaseError(agentTaskLeaseErrorCodes.inputInvalid));
    await expect(
      service.execute({ agentId: "agent-1", hostId: "host-1" }, claimCommand(), NOW, NOW),
    ).rejects.toEqual(new AgentTaskLeaseError(agentTaskLeaseErrorCodes.authorizationExpired));
    await expect(
      service.execute(
        { agentId: "agent-1", hostId: "host-1" },
        { ...claimCommand(), validUntil: NOW.toISOString() },
        AUTHORIZATION_EXPIRY,
        NOW,
      ),
    ).rejects.toEqual(new AgentTaskLeaseError(agentTaskLeaseErrorCodes.authorizationExpired));
  });
});
