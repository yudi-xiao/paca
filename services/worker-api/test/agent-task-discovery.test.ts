import type { AgentSession, CapabilityConstraints } from "@better-auth/agent-auth";
import { describe, expect, it, vi } from "vitest";

import {
  type AgentTaskDiscoveryDependencies,
  discoverAgentTasks,
} from "../src/agent-task/discovery";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-02T06:00:00.000Z");
const VALID_UNTIL = "2026-09-02T07:00:00.000Z";

function session(
  constraints: CapabilityConstraints = {
    organizationId: "paca-default",
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    operationMode: "execute",
    action: { in: ["claim", "renew", "checkpoint", "complete", "fail", "cancel_ack"] },
    validUntil: VALID_UNTIL,
  },
): AgentSession {
  return {
    type: "delegated",
    agentId: "agent-1",
    userId: "user-1",
    agent: {
      id: "agent-1",
      name: "Local Harness Agent",
      mode: "delegated",
      capabilityGrants: [
        {
          capability: "task.execute",
          constraints,
          grantedBy: "approver-1",
          status: "active",
        },
      ],
      hostId: "host-1",
      createdAt: NOW,
      activatedAt: NOW,
      metadata: null,
    },
    host: { id: "host-1", userId: "user-1", status: "active" },
    user: { id: "user-1", name: "User", email: "user@paca.test" },
  };
}

function dependencies(): AgentTaskDiscoveryDependencies {
  return {
    authorizeScope: vi.fn(async () => true),
    findTasks: vi.fn(async () => [
      {
        id: TASK_ID,
        projectId: PROJECT_ID,
        taskNumber: 1,
        title: "Run the local Harness",
        statusId: null,
        updatedAt: NOW,
      },
    ]),
    findActiveLeases: vi.fn(async () => []),
  };
}

describe("Agent task discovery", () => {
  it("returns only exact approved task.execute scopes that still pass delegated permission", async () => {
    const deps = dependencies();
    const result = await discoverAgentTasks(deps, session(), NOW);

    expect(result).toEqual([
      expect.objectContaining({
        organizationId: "paca-default",
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        title: "Run the local Harness",
        validUntil: VALID_UNTIL,
        availability: "claimable",
        lease: null,
      }),
    ]);
    expect(deps.authorizeScope).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-1" }),
      expect.objectContaining({ taskId: TASK_ID, validUntilDate: new Date(VALID_UNTIL) }),
    );
  });

  it("omits expired, non-claimable, permission-revoked and mismatched Host grants", async () => {
    const expired = session({
      organizationId: "paca-default",
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      operationMode: "execute",
      action: "claim",
      validUntil: "2026-09-02T05:59:59.000Z",
    });
    await expect(discoverAgentTasks(dependencies(), expired, NOW)).resolves.toEqual([]);

    const noClaim = session({
      organizationId: "paca-default",
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      operationMode: "execute",
      action: "renew",
      validUntil: VALID_UNTIL,
    });
    await expect(discoverAgentTasks(dependencies(), noClaim, NOW)).resolves.toEqual([]);

    const denied = dependencies();
    vi.mocked(denied.authorizeScope).mockResolvedValue(false);
    await expect(discoverAgentTasks(denied, session(), NOW)).resolves.toEqual([]);

    const wrongHost = session();
    if (wrongHost.host) wrongHost.host.id = "host-2";
    await expect(discoverAgentTasks(dependencies(), wrongHost, NOW)).resolves.toEqual([]);
  });

  it("returns the current Agent's live lease for resume and hides competing leases", async () => {
    const own = dependencies();
    vi.mocked(own.findActiveLeases).mockResolvedValue([
      {
        id: "33333333-3333-4333-8333-333333333333",
        taskId: TASK_ID,
        agentId: "agent-1",
        hostId: "host-1",
        harnessKind: "codex",
        harnessVersion: "1.0.0",
        harnessInstanceId: "local-1",
        status: "active",
        version: 3,
        lastCheckpointSequence: 2,
        leaseExpiresAt: new Date("2026-09-02T06:05:00.000Z"),
      },
    ]);
    await expect(discoverAgentTasks(own, session(), NOW)).resolves.toEqual([
      expect.objectContaining({
        availability: "owned",
        lease: expect.objectContaining({
          harnessKind: "codex",
          lastCheckpointSequence: 2,
        }),
      }),
    ]);

    const competing = dependencies();
    vi.mocked(competing.findActiveLeases).mockResolvedValue([
      {
        id: "33333333-3333-4333-8333-333333333333",
        taskId: TASK_ID,
        agentId: "agent-2",
        hostId: "host-2",
        harnessKind: "cloudflare-agent",
        harnessVersion: null,
        harnessInstanceId: null,
        status: "active",
        version: 1,
        lastCheckpointSequence: 0,
        leaseExpiresAt: new Date("2026-09-02T06:05:00.000Z"),
      },
    ]);
    await expect(discoverAgentTasks(competing, session(), NOW)).resolves.toEqual([]);
  });
});
