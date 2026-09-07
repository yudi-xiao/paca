import { describe, expect, it, vi } from "vitest";

import type { ProjectAgentDirectoryRuntime } from "../src/agent-directory/runtime";
import { createApp } from "../src/app";
import type { AppBindings } from "../src/bindings";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-09-07T08:00:00.000Z");

function bindings(): AppBindings {
  return { ENVIRONMENT: "test" } as AppBindings;
}

describe("Project Agent directory HTTP contract", () => {
  it("requires agents.read and returns a secret-free legacy envelope", async () => {
    const list = vi.fn<ProjectAgentDirectoryRuntime["list"]>(async () => [
      {
        agentId: "agent-1",
        name: "Codex",
        status: "active",
        mode: "delegated",
        hostId: "host-1",
        hostName: "Mac Runner",
        hostStatus: "active",
        hostOnline: true,
        harnessKinds: ["codex"],
        authorizationStatus: "active",
        capabilityGrants: [
          {
            id: "grant-1",
            capability: "task.read",
            status: "active",
            validUntil: new Date("2026-09-07T08:15:00.000Z"),
            expiresAt: null,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        createdAt: NOW,
        updatedAt: NOW,
        lastUsedAt: null,
        expiresAt: null,
      },
    ]);
    const authorizeProjectPermission = vi.fn(async () => ({
      authenticated: true as const,
      userId: "user-1",
      decision: {
        allowed: true,
        scopeExists: true,
        grants: [{ resource: "agents" as const, action: "read" }],
      },
    }));
    const app = createApp({
      authorizeProjectPermission,
      projectAgentDirectory: { list },
      log: vi.fn(),
    });

    const response = await app.request(`/api/v1/projects/${PROJECT_ID}/agents`, {}, bindings());

    expect(response.status).toBe(200);
    expect(authorizeProjectPermission).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      PROJECT_ID,
      { agents: ["read"] },
    );
    expect(list).toHaveBeenCalledWith(expect.anything(), PROJECT_ID);
    const body = await response.json();
    expect(body).toMatchObject({
      success: true,
      data: {
        items: [
          {
            agent_id: "agent-1",
            host_id: "host-1",
            authorization_status: "active",
            capability_grants: [{ capability: "task.read", status: "active" }],
          },
        ],
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/public_key|constraints|token|secret/i);
  });

  it("does not query Agent identities when project permission is denied", async () => {
    const list = vi.fn<ProjectAgentDirectoryRuntime["list"]>();
    const app = createApp({
      authorizeProjectPermission: async () => ({
        authenticated: true,
        userId: "user-1",
        decision: { allowed: false, scopeExists: true, grants: [] },
      }),
      projectAgentDirectory: { list },
      log: vi.fn(),
    });

    const response = await app.request(`/api/v1/projects/${PROJECT_ID}/agents`, {}, bindings());

    expect(response.status).toBe(403);
    expect(list).not.toHaveBeenCalled();
  });
});
