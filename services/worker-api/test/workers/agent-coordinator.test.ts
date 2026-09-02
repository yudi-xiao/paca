/// <reference types="@cloudflare/vitest-plugin/types" />

import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const AGENT_ID = "agent-runtime-1";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const IDEMPOTENCY_KEY = "22222222-2222-4222-8222-222222222222";
const LEASE_ID = "abababab-abab-4bab-8bab-abababababab";

function runInput(overrides: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    requestHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    agentId: AGENT_ID,
    workflowId: "33333333-3333-4333-8333-333333333333",
    organizationId: "organization-1",
    projectId: "44444444-4444-4444-8444-444444444444",
    documentId: "55555555-5555-4555-8555-555555555555",
    kind: "document.edit" as const,
    ...overrides,
  };
}

describe("AgentCoordinator Durable Object", () => {
  it("persists run state and transition idempotency across eviction", async () => {
    const stub = env.AgentCoordinator.getByName(AGENT_ID);
    await expect(stub.createRun(runInput())).resolves.toMatchObject({
      success: true,
      duplicate: false,
      run: { runId: RUN_ID, status: "queued", version: 1 },
    });
    await expect(stub.createRun(runInput())).resolves.toMatchObject({ duplicate: true });

    const transition = {
      transitionId: "66666666-6666-4666-8666-666666666666",
      runId: RUN_ID,
      status: "running" as const,
    };
    await expect(stub.transitionRun(transition)).resolves.toMatchObject({
      duplicate: false,
      run: { status: "running", version: 2 },
    });
    await evictDurableObject(stub);
    await expect(stub.transitionRun(transition)).resolves.toMatchObject({
      duplicate: true,
      run: { status: "running", version: 2 },
    });
    await expect(stub.getRun(RUN_ID)).resolves.toMatchObject({ status: "running", version: 2 });
    await expect(stub.getRuntimeState()).resolves.toEqual({
      schemaVersion: 1,
      lastRunId: RUN_ID,
      lastRunStatus: "running",
      lastRunVersion: 2,
      updatedAt: expect.any(Number),
    });
  });

  it("keeps Agents SDK state bounded and free of task payloads or credentials", async () => {
    const stub = env.AgentCoordinator.getByName("agent-runtime-bounded-state");
    await stub.createRun(
      runInput({
        agentId: "agent-runtime-bounded-state",
        runId: "12121212-1212-4212-8212-121212121212",
        idempotencyKey: "34343434-3434-4434-8434-343434343434",
      }),
    );

    const state = await stub.getRuntimeState();
    expect(Object.keys(state).sort()).toEqual(
      ["lastRunId", "lastRunStatus", "lastRunVersion", "schemaVersion", "updatedAt"].sort(),
    );
    expect(JSON.stringify(state)).not.toContain("requestHash");
    expect(JSON.stringify(state)).not.toContain("grant");
    expect(JSON.stringify(state)).not.toContain("token");
  });

  it("rejects changed retry payloads and invalid terminal transitions", async () => {
    const stub = env.AgentCoordinator.getByName("agent-runtime-2");
    const scoped = runInput({
      agentId: "agent-runtime-2",
      runId: "77777777-7777-4777-8777-777777777777",
      idempotencyKey: "88888888-8888-4888-8888-888888888888",
    });
    await stub.createRun(scoped);
    await expect(
      stub.createRun({
        ...scoped,
        documentId: "99999999-9999-4999-8999-999999999999",
      }),
    ).resolves.toEqual({ success: false, errorCode: "AGENT_RUN_IDEMPOTENCY_CONFLICT" });
    await stub.transitionRun({
      transitionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      runId: scoped.runId,
      status: "failed",
      errorCode: "AGENT_GRANT_REVOKED",
    });
    await expect(
      stub.transitionRun({
        transitionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        runId: scoped.runId,
        status: "running",
      }),
    ).resolves.toEqual({ success: false, errorCode: "AGENT_RUN_TRANSITION_INVALID" });
  });

  it("pins one Better Auth Agent identity to each coordinator instance", async () => {
    const stub = env.AgentCoordinator.getByName("agent-runtime-3");
    await stub.createRun(
      runInput({
        agentId: "agent-runtime-3",
        runId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        idempotencyKey: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      }),
    );
    await expect(
      stub.createRun(
        runInput({
          agentId: "different-agent",
          runId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          idempotencyKey: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        }),
      ),
    ).resolves.toEqual({ success: false, errorCode: "AGENT_COORDINATOR_SCOPE_MISMATCH" });
  });

  it("persists a bounded Cloudflare task lease mirror monotonically across eviction", async () => {
    const agentId = "agent-runtime-task-lease";
    const stub = env.AgentCoordinator.getByName(agentId);
    const lease = {
      requestId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
      leaseId: LEASE_ID,
      organizationId: "organization-1",
      projectId: "44444444-4444-4444-8444-444444444444",
      taskId: "56565656-5656-4656-8656-565656565656",
      agentId,
      hostId: "host-1",
      harnessKind: "cloudflare-agent" as const,
      status: "active" as const,
      version: 1,
      lastCheckpointSequence: 0,
      leaseExpiresAt: Date.now() + 30_000,
      finishedAt: null,
      errorCode: null,
      updatedAt: Date.now(),
    };
    await expect(stub.recordTaskLease(lease)).resolves.toMatchObject({
      success: true,
      duplicate: false,
      lease: { leaseId: LEASE_ID, version: 1 },
    });
    await expect(stub.recordTaskLease(lease)).resolves.toMatchObject({ duplicate: true });

    const renewed = {
      ...lease,
      requestId: "efefefef-efef-4fef-8fef-efefefefefef",
      version: 2,
      leaseExpiresAt: lease.leaseExpiresAt + 30_000,
      updatedAt: lease.updatedAt + 1,
    };
    await expect(stub.recordTaskLease(renewed)).resolves.toMatchObject({
      duplicate: false,
      lease: { version: 2 },
    });
    await evictDurableObject(stub);
    await expect(stub.getTaskLease(LEASE_ID)).resolves.toMatchObject({
      requestId: renewed.requestId,
      version: 2,
    });
    await expect(stub.recordTaskLease(lease)).resolves.toMatchObject({
      success: true,
      duplicate: true,
      lease: { version: 2 },
    });
  });
});
