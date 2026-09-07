import { describe, expect, it, vi } from "vitest";

import {
  type ProjectAgentDirectoryCandidate,
  type ProjectAgentDirectoryRepository,
  ProjectAgentDirectoryService,
} from "../src/agent-directory/service";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-07T08:00:00.000Z");

function candidate(
  overrides: Partial<ProjectAgentDirectoryCandidate> = {},
): ProjectAgentDirectoryCandidate {
  return {
    agentId: "agent-1",
    agentName: "Codex",
    agentStatus: "active",
    agentMode: "delegated",
    agentCreatedAt: new Date("2026-09-01T00:00:00.000Z"),
    agentUpdatedAt: new Date("2026-09-07T00:00:00.000Z"),
    agentLastUsedAt: new Date("2026-09-07T07:59:00.000Z"),
    agentExpiresAt: null,
    hostId: "host-1",
    hostName: "Mac Runner",
    hostStatus: "active",
    heartbeatExpiresAt: new Date("2026-09-07T08:02:00.000Z"),
    reportedHarnessKinds: ["codex", "codex"],
    grantId: "grant-1",
    grantCapability: "task.read",
    grantStatus: "active",
    grantConstraints: JSON.stringify({
      organizationId: "paca-default",
      projectId: PROJECT_ID,
      taskId: "33333333-3333-4333-8333-333333333333",
      validUntil: "2026-09-07T08:15:00.000Z",
    }),
    grantExpiresAt: new Date("2026-09-07T08:15:00.000Z"),
    grantCreatedAt: new Date("2026-09-07T07:55:00.000Z"),
    grantUpdatedAt: new Date("2026-09-07T07:55:00.000Z"),
    ...overrides,
  };
}

function repository(values: ProjectAgentDirectoryCandidate[]): ProjectAgentDirectoryRepository {
  return { listCandidates: vi.fn(async () => values) };
}

describe("Project Agent directory service", () => {
  it("groups exact Project grants and exposes only the latest grant per capability", async () => {
    const oldGrant = candidate({
      grantId: "grant-old",
      grantStatus: "revoked",
      grantCreatedAt: new Date("2026-09-06T00:00:00.000Z"),
    });
    const taskWrite = candidate({
      grantId: "grant-write",
      grantCapability: "task.write",
      grantConstraints: JSON.stringify({
        projectId: { eq: PROJECT_ID },
        validUntil: { eq: "2026-09-07T08:10:00.000Z" },
      }),
    });
    const result = await new ProjectAgentDirectoryService(
      repository([oldGrant, candidate(), taskWrite]),
    ).list(PROJECT_ID, NOW);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      agentId: "agent-1",
      hostOnline: true,
      harnessKinds: ["codex"],
      authorizationStatus: "active",
      capabilityGrants: [
        { id: "grant-1", capability: "task.read", status: "active" },
        { id: "grant-write", capability: "task.write", status: "active" },
      ],
    });
  });

  it("fails closed for malformed and substring-only constraints", async () => {
    const result = await new ProjectAgentDirectoryService(
      repository([
        candidate({ grantConstraints: "not-json" }),
        candidate({
          grantId: "grant-other",
          grantConstraints: JSON.stringify({
            projectId: OTHER_PROJECT_ID,
            note: PROJECT_ID,
            validUntil: "2026-09-07T08:15:00.000Z",
          }),
        }),
      ]),
    ).list(PROJECT_ID, NOW);

    expect(result).toEqual([]);
  });

  it("keeps historical association but marks expired or revoked grants inactive", async () => {
    const result = await new ProjectAgentDirectoryService(
      repository([
        candidate({
          grantStatus: "pending",
          grantExpiresAt: null,
          grantConstraints: JSON.stringify({
            projectId: PROJECT_ID,
            validUntil: "2026-09-07T07:59:59.000Z",
          }),
        }),
      ]),
    ).list(PROJECT_ID, NOW);

    expect(result[0]).toMatchObject({
      authorizationStatus: "inactive",
      capabilityGrants: [{ status: "inactive" }],
    });
  });
});
