import { describe, expect, it, vi } from "vitest";

import {
  AGENT_HOST_EXECUTION_LABEL,
  AgentHostRuntimeError,
  type AgentHostRuntimeProfile,
  type AgentHostRuntimeRepository,
  AgentHostRuntimeService,
  agentHostMatchesTask,
  effectiveAgentHostLabels,
} from "../src/agent-task/host-runtime";

const NOW = new Date("2026-09-02T08:00:00.000Z");

function profile(overrides: Partial<AgentHostRuntimeProfile> = {}): AgentHostRuntimeProfile {
  return {
    hostId: "host-1",
    hostName: "Mac Runner",
    hostStatus: "active",
    approvedLabels: [AGENT_HOST_EXECUTION_LABEL, "harness:codex", "tool:shell"],
    reportedLabels: [AGENT_HOST_EXECUTION_LABEL, "harness:codex"],
    reportedHarnessKinds: ["codex"],
    effectiveLabels: [AGENT_HOST_EXECUTION_LABEL, "harness:codex"],
    labelsVersion: 1,
    approvedBy: "user-1",
    approvedAt: NOW,
    lastHeartbeatAt: NOW,
    heartbeatExpiresAt: new Date(NOW.getTime() + 120_000),
    online: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function repository(): AgentHostRuntimeRepository {
  return {
    heartbeat: vi.fn(async () => profile()),
    approveLabels: vi.fn(async () => profile()),
    list: vi.fn(async () => [profile()]),
    matchTasks: vi.fn(async () => new Set(["task-1"])),
    getTaskRequirement: vi.fn(async () => null),
    setTaskRequirement: vi.fn(async (_projectId, taskId, updatedBy, requiredLabels) => ({
      taskId,
      projectId: "project-1",
      requiredLabels,
      updatedBy,
      createdAt: NOW,
      updatedAt: NOW,
    })),
  };
}

describe("Agent Host runtime labels", () => {
  it("normalizes reported labels and derives Harness labels without approving them", async () => {
    const repo = repository();
    const service = new AgentHostRuntimeService(repo);

    await service.heartbeat(
      "host-1",
      {
        harnesses: [{ kind: "codex", version: "1.0.0", instanceId: "local-1" }],
        labels: ["tool:shell", "tool:shell", AGENT_HOST_EXECUTION_LABEL],
      },
      NOW,
    );

    expect(repo.heartbeat).toHaveBeenCalledWith(
      "host-1",
      {
        harnesses: [{ kind: "codex" }],
        labels: ["harness:codex", AGENT_HOST_EXECUTION_LABEL, "tool:shell"],
      },
      NOW,
    );
  });

  it("rejects unbounded or malformed labels before repository access", async () => {
    const repo = repository();
    const service = new AgentHostRuntimeService(repo);

    expect(() =>
      service.heartbeat("host-1", {
        harnesses: [{ kind: "codex" }],
        labels: ["Shell Access"],
      }),
    ).toThrow(new AgentHostRuntimeError("AGENT_HOST_RUNTIME_INPUT_INVALID"));
    expect(repo.heartbeat).not.toHaveBeenCalled();
  });

  it("matches only the approved and currently reported label intersection", () => {
    expect(
      effectiveAgentHostLabels(
        [AGENT_HOST_EXECUTION_LABEL, "harness:codex", "tool:shell"],
        [AGENT_HOST_EXECUTION_LABEL, "harness:codex", "tool:browser"],
      ),
    ).toEqual(["harness:codex", AGENT_HOST_EXECUTION_LABEL]);
    expect(agentHostMatchesTask(profile(), ["harness:codex"])).toBe(true);
    expect(agentHostMatchesTask(profile(), ["tool:shell"])).toBe(false);
    expect(agentHostMatchesTask(profile({ online: false }), [])).toBe(false);
  });

  it("keeps approval and task requirements server-controlled", async () => {
    const repo = repository();
    const service = new AgentHostRuntimeService(repo);

    await service.approveLabels(
      "host-1",
      "approver-1",
      { approved_labels: ["tool:shell", AGENT_HOST_EXECUTION_LABEL, "tool:shell"] },
      NOW,
    );
    expect(repo.approveLabels).toHaveBeenCalledWith(
      "host-1",
      "approver-1",
      [AGENT_HOST_EXECUTION_LABEL, "tool:shell"],
      NOW,
    );

    await service.setTaskRequirement(
      "project-1",
      "task-1",
      "approver-1",
      { required_labels: ["tool:shell"] },
      NOW,
    );
    expect(repo.setTaskRequirement).toHaveBeenCalledWith(
      "project-1",
      "task-1",
      "approver-1",
      ["tool:shell"],
      NOW,
    );
  });
});
