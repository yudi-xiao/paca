import type { AgentSession, CapabilityConstraints } from "@better-auth/agent-auth";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import type { AppBindings } from "../src/bindings";
import type { Project } from "../src/project/service";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const VALID_UNTIL = "2099-08-28T00:00:00.000Z";

const project: Project = {
  id: PROJECT_ID,
  organizationId: "paca-default",
  name: "Agent-visible project",
  description: "",
  taskIdPrefix: "AGENT",
  isPublic: false,
  settings: {},
  createdBy: "user-1",
  createdAt: new Date("2026-08-28T00:00:00.000Z"),
  updatedAt: new Date("2026-08-28T00:00:00.000Z"),
};

function bindings(): AppBindings {
  return { ENVIRONMENT: "test" } as AppBindings;
}

function session(constraints: CapabilityConstraints): AgentSession {
  const now = new Date("2026-08-28T00:00:00.000Z");
  return {
    type: "delegated",
    agentId: "agent-1",
    userId: "user-1",
    agent: {
      id: "agent-1",
      name: "HTTP Agent",
      mode: "delegated",
      capabilityGrants: [
        {
          capability: "project.read",
          constraints,
          grantedBy: "approver-1",
          status: "active",
        },
      ],
      hostId: "host-1",
      createdAt: now,
      activatedAt: now,
      metadata: null,
    },
    host: { id: "host-1", userId: "user-1", status: "active" },
    user: { id: "user-1", name: "User", email: "user@paca.test" },
  };
}

const scope = {
  organizationId: "paca-default",
  projectId: PROJECT_ID,
  validUntil: VALID_UNTIL,
} satisfies CapabilityConstraints;

describe("Agent Auth Hono boundary", () => {
  it("requires an Agent Auth session instead of a user session", async () => {
    const currentAgentSession = vi.fn(async () => null);
    const agentProject = vi.fn(async () => project);
    const app = createApp({ currentAgentSession, agentProject, log: vi.fn() });

    const response = await app.request(`/api/v1/agent/projects/${PROJECT_ID}`, {}, bindings());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error_code: "AGENT_UNAUTHENTICATED",
    });
    expect(agentProject).not.toHaveBeenCalled();
  });

  it("maps invalid or replayed JWT verification failures to an authentication rejection", async () => {
    const currentAgentSession = vi.fn(async () => {
      throw Object.assign(new Error("JWT has already been used"), { statusCode: 401 });
    });
    const agentProject = vi.fn(async () => project);
    const app = createApp({ currentAgentSession, agentProject, log: vi.fn() });

    const response = await app.request(`/api/v1/agent/projects/${PROJECT_ID}`, {}, bindings());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error_code: "AGENT_TOKEN_INVALID" });
    expect(agentProject).not.toHaveBeenCalled();
  });

  it("does not disguise database failures as invalid credentials", async () => {
    const currentAgentSession = vi.fn(async () => {
      throw new Error("DATABASE_UNAVAILABLE");
    });
    const app = createApp({ currentAgentSession, log: vi.fn() });

    const response = await app.request(`/api/v1/agent/projects/${PROJECT_ID}`, {}, bindings());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("rejects a Project outside the active Grant constraints", async () => {
    const currentAgentSession = vi.fn(async () => session(scope));
    const agentProject = vi.fn(async () => project);
    const app = createApp({ currentAgentSession, agentProject, log: vi.fn() });

    const response = await app.request(
      `/api/v1/agent/projects/${OTHER_PROJECT_ID}`,
      {},
      bindings(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error_code: "AGENT_GRANT_CONSTRAINT_MISMATCH",
    });
    expect(agentProject).not.toHaveBeenCalled();
  });

  it("passes a validated scope and Agent session to the delegated permission intersection", async () => {
    const agentSession = session(scope);
    const currentAgentSession = vi.fn(async () => agentSession);
    const agentProject = vi.fn(async () => project);
    const app = createApp({ currentAgentSession, agentProject, log: vi.fn() });

    const response = await app.request(`/api/v1/agent/projects/${PROJECT_ID}`, {}, bindings());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { id: PROJECT_ID, name: "Agent-visible project" },
    });
    expect(agentProject).toHaveBeenCalledWith(bindings(), agentSession, {
      organizationId: "paca-default",
      projectId: PROJECT_ID,
      validUntil: VALID_UNTIL,
    });
  });

  it("discovers only server-authorized task.execute work through the Agent boundary", async () => {
    const agentSession = session(scope);
    const currentAgentSession = vi.fn(async () => agentSession);
    const agentTasks = {
      list: vi.fn(async () => [
        {
          organizationId: "paca-default",
          projectId: PROJECT_ID,
          taskId: OTHER_PROJECT_ID,
          taskNumber: 7,
          title: "Execute approved work",
          statusId: null,
          taskUpdatedAt: new Date("2026-08-28T01:00:00.000Z"),
          validUntil: VALID_UNTIL,
          availability: "claimable" as const,
          lease: null,
        },
      ]),
    };
    const app = createApp({ currentAgentSession, agentTasks, log: vi.fn() });

    const response = await app.request("/api/v1/agent/tasks/claimable", {}, bindings());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: [
        {
          organization_id: "paca-default",
          project_id: PROJECT_ID,
          task_id: OTHER_PROJECT_ID,
          task_number: 7,
          title: "Execute approved work",
          valid_until: VALID_UNTIL,
          availability: "claimable",
          lease: null,
        },
      ],
    });
    expect(agentTasks.list).toHaveBeenCalledWith(bindings(), agentSession);
  });
});
