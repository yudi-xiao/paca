import type { AgentSession } from "@better-auth/agent-auth";
import { describe, expect, it, vi } from "vitest";
import type { AgentTaskControlRuntime } from "../src/agent-task/control-runtime";
import type { AgentHostRuntimeProfile } from "../src/agent-task/host-runtime";
import type { AgentHostRuntime } from "../src/agent-task/host-runtime-runtime";
import { createApp } from "../src/app";
import type { AppBindings } from "../src/bindings";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-02T08:00:00.000Z");

function bindings(): AppBindings {
  return { ENVIRONMENT: "test" } as AppBindings;
}

function session(): AgentSession {
  return {
    type: "delegated",
    agentId: "agent-1",
    userId: "user-1",
    agent: {
      id: "agent-1",
      name: "Codex Agent",
      mode: "delegated",
      capabilityGrants: [],
      hostId: "host-1",
      createdAt: NOW,
      activatedAt: NOW,
      metadata: null,
    },
    host: { id: "host-1", userId: "user-1", status: "active" },
    user: { id: "user-1", name: "User", email: "user@paca.test" },
  };
}

function profile(): AgentHostRuntimeProfile {
  return {
    hostId: "host-1",
    hostName: "Mac Runner",
    hostStatus: "active",
    approvedLabels: ["task:execute", "harness:codex"],
    reportedLabels: ["task:execute", "harness:codex"],
    reportedHarnessKinds: ["codex"],
    effectiveLabels: ["task:execute", "harness:codex"],
    labelsVersion: 2,
    approvedBy: "admin-1",
    approvedAt: NOW,
    lastHeartbeatAt: NOW,
    heartbeatExpiresAt: new Date(NOW.getTime() + 120_000),
    online: true,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function runtime(): AgentHostRuntime {
  return {
    heartbeat: vi.fn(async () => profile()),
    approveLabels: vi.fn(async () => profile()),
    list: vi.fn(async () => [profile()]),
    getTaskRequirement: vi.fn(async () => null),
    setTaskRequirement: vi.fn(async (_env, projectId, taskId, updatedBy, value) => ({
      projectId,
      taskId,
      requiredLabels: (value as { required_labels: string[] }).required_labels,
      updatedBy,
      createdAt: NOW,
      updatedAt: NOW,
    })),
  };
}

describe("Agent Host runtime HTTP boundary", () => {
  it("accepts heartbeat only from a verified Agent/Host session", async () => {
    const currentAgentSession = vi.fn(async () => session());
    const agentHosts = runtime();
    const app = createApp({ currentAgentSession, agentHosts, log: vi.fn() });
    const body = {
      harnesses: [{ kind: "codex", version: "1.0.0", instanceId: "local-1" }],
      labels: ["task:execute"],
    };

    const response = await app.request(
      "/api/v1/agent/host/heartbeat",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      bindings(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        host_id: "host-1",
        online: true,
        approved_labels: ["task:execute", "harness:codex"],
        effective_labels: ["task:execute", "harness:codex"],
      },
    });
    expect(agentHosts.heartbeat).toHaveBeenCalledWith(bindings(), session(), body);
  });

  it("requires system Agent permissions to approve Host labels", async () => {
    const agentHosts = runtime();
    const authorizeSystemPermission = vi.fn(async () => ({
      authenticated: true as const,
      userId: "admin-1",
      grants: [{ resource: "agents" as const, action: "write" }],
      allowed: true,
    }));
    const app = createApp({ authorizeSystemPermission, agentHosts, log: vi.fn() });

    const response = await app.request(
      "/api/v1/agent/hosts/host-1/runtime",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approved_labels: ["task:execute", "harness:codex"] }),
      },
      bindings(),
    );

    expect(response.status).toBe(200);
    expect(agentHosts.approveLabels).toHaveBeenCalledWith(bindings(), "host-1", "admin-1", {
      approved_labels: ["task:execute", "harness:codex"],
    });
  });

  it("requires project approveGrant before changing task matching labels", async () => {
    const agentHosts = runtime();
    const authorizeProjectPermission = vi.fn(async () => ({
      authenticated: true as const,
      userId: "approver-1",
      decision: {
        allowed: true,
        scopeExists: true,
        grants: [
          { resource: "agents" as const, action: "approveGrant" },
          { resource: "tasks" as const, action: "read" },
        ],
      },
    }));
    const app = createApp({ authorizeProjectPermission, agentHosts, log: vi.fn() });

    const response = await app.request(
      `/api/v1/projects/${PROJECT_ID}/tasks/${TASK_ID}/agent-requirements`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ required_labels: ["harness:codex"] }),
      },
      bindings(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { task_id: TASK_ID, required_labels: ["harness:codex"] },
    });
    expect(agentHosts.setTaskRequirement).toHaveBeenCalledWith(
      bindings(),
      PROJECT_ID,
      TASK_ID,
      "approver-1",
      { required_labels: ["harness:codex"] },
    );
  });

  it("lets a task writer terminate the active Agent lease with an audited request id", async () => {
    const requestCancel = vi.fn(async () => ({
      duplicate: false,
      lease: {
        id: "33333333-3333-4333-8333-333333333333",
        organizationId: "paca-default",
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        agentId: "agent-1",
        hostId: "host-1",
        harness: { kind: "codex" as const, version: null, instanceId: null },
        status: "cancelled" as const,
        version: 2,
        lastCheckpointSequence: 0,
        leaseExpiresAt: new Date(NOW.getTime() + 30_000),
        claimedAt: NOW,
        finishedAt: NOW,
        errorCode: null,
        resultSummary: "用户停止测试",
        createdAt: NOW,
        updatedAt: NOW,
      },
    }));
    const agentTaskControl = { requestCancel } satisfies AgentTaskControlRuntime;
    const authorizeProjectPermission = vi.fn(async () => ({
      authenticated: true as const,
      userId: "editor-1",
      decision: {
        allowed: true,
        scopeExists: true,
        grants: [{ resource: "tasks" as const, action: "write" }],
      },
    }));
    const app = createApp({ authorizeProjectPermission, agentTaskControl, log: vi.fn() });
    const requestId = "44444444-4444-4444-8444-444444444444";

    const response = await app.request(
      `/api/v1/projects/${PROJECT_ID}/tasks/${TASK_ID}/agent-lease/cancel`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request_id: requestId, reason: "用户停止测试" }),
      },
      bindings(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { duplicate: false, lease: { status: "cancelled", version: 2 } },
    });
    expect(requestCancel).toHaveBeenCalledWith(bindings(), PROJECT_ID, TASK_ID, "editor-1", {
      requestId,
      reason: "用户停止测试",
    });
  });
});
