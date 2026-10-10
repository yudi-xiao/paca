import type { AgentSession, CapabilityConstraints } from "@better-auth/agent-auth";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { AppBindings } from "../src/bindings";
import type { AuthorizeProjectPermission } from "../src/permission/http";
import { agentSearchIds } from "../src/search/agent-scope";
import type { ProjectSearchRuntime } from "../src/search/runtime";
import { ProjectSearchError, ProjectSearchService } from "../src/search/service";

const projectId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const otherId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-10-10T00:00:00Z");
function session(constraints: CapabilityConstraints = {}, capability = "task.read"): AgentSession {
  return {
    type: "autonomous",
    userId: null,
    user: { id: "agent:agent-1", name: "Agent", email: "agent@agents.invalid" },
    agentId: "agent-1",
    agent: {
      id: "agent-1",
      name: "Local Codex",
      mode: "autonomous",
      hostId: "host-1",
      createdAt: now,
      activatedAt: now,
      metadata: null,
      capabilityGrants: [
        {
          capability,
          status: "active",
          grantedBy: "user-1",
          constraints: {
            organizationId: "org-1",
            projectId,
            taskId,
            validUntil: "2026-10-10T01:00:00Z",
            ...constraints,
          },
        },
      ],
    },
    host: { id: "host-1", userId: "user-1", status: "active" },
  };
}
describe("project search resource scope", () => {
  it("unions only explicit readable IDs, including eq/in constraints", () => {
    const agent = session({ taskId: { in: [taskId, otherId, taskId] } });
    expect(agentSearchIds(agent, projectId, "org-1", "tasks", now)).toEqual([taskId, otherId]);
    expect(
      agentSearchIds(
        session({ documentId: { eq: taskId } }, "document.read"),
        projectId,
        "org-1",
        "docs",
        now,
      ),
    ).toEqual([taskId]);
  });
  it.each([
    { taskId: "*" },
    { taskId: { not_in: [otherId] } },
    { taskId: { in: ["invalid"] } },
    { projectId: otherId },
    { organizationId: "other" },
    { validUntil: "2026-10-09T00:00:00Z" },
    { validUntil: null },
    { taskId: null },
  ])("rejects unbounded, foreign and expired grants: %j", (constraints) => {
    expect(() =>
      agentSearchIds(
        session(constraints as unknown as CapabilityConstraints),
        projectId,
        "org-1",
        "tasks",
        now,
      ),
    ).toThrow("SEARCH_SCOPE_DENIED");
  });
  it.each([
    "project.read",
    "task.write",
    "task.execute",
    "document.read",
  ])("does not expand %s into task body visibility", (capability) => {
    expect(() => agentSearchIds(session({}, capability), projectId, "org-1", "tasks", now)).toThrow(
      "SEARCH_SCOPE_DENIED",
    );
  });
  it("honors revocation and Host binding", () => {
    const agent = session();
    const grant = agent.agent.capabilityGrants[0];
    if (!grant) throw Error();
    grant.status = "revoked";
    expect(() => agentSearchIds(agent, projectId, "org-1", "tasks", now)).toThrow(
      "SEARCH_SCOPE_DENIED",
    );
    const other = session();
    if (!other.host) throw Error();
    other.host.id = "foreign-host";
    expect(() => agentSearchIds(other, projectId, "org-1", "tasks", now)).toThrow(
      "SEARCH_SCOPE_DENIED",
    );
  });
});

describe("search input and cursor", () => {
  it.each(["", " ", "x".repeat(201)])("bounds queries before database work", async (query) => {
    const search = vi.fn(async () => []);
    const service = new ProjectSearchService({ search });
    await expect(service.search({ projectId, kind: "tasks", query })).rejects.toThrow(
      "SEARCH_INPUT_INVALID",
    );
    expect(search).not.toHaveBeenCalled();
  });
  it.each([
    "!invalid",
    "e30",
    "x".repeat(2049),
  ])("rejects malformed/oversized cursors", async (cursor) => {
    const search = vi.fn(async () => []);
    await expect(
      new ProjectSearchService({ search }).search({
        projectId,
        kind: "docs",
        query: "needle",
        cursor,
      }),
    ).rejects.toThrow();
    expect(search).not.toHaveBeenCalled();
  });
  it("does not query an empty Agent resource scope", async () => {
    const search = vi.fn(async () => []);
    expect(
      await new ProjectSearchService({ search }).search(
        { projectId, kind: "docs", query: "needle" },
        [],
      ),
    ).toMatchObject({ items: [], nextCursor: null });
    expect(search).not.toHaveBeenCalled();
  });
});

const allow: AuthorizeProjectPermission = async () => ({
  authenticated: true,
  userId: "user-1",
  decision: { allowed: true, scopeExists: true, grants: [] },
});
const env = { ENVIRONMENT: "test" } as AppBindings;
function runtime(): ProjectSearchRuntime {
  const page = {
    items: [
      {
        id: taskId,
        title: "Safe title",
        taskNumber: 1,
        matchedIn: "content" as const,
        snippet: "needle",
        createdAt: now,
        updatedAt: now,
        cursorCreatedAt: "2026-10-10T00:00:00.123456Z",
      },
    ],
    nextCursor: null,
    matching: "literal" as const,
  };
  return { user: vi.fn(async () => page), agent: vi.fn(async () => page) };
}
describe("search HTTP boundaries", () => {
  it.each(["tasks", "docs"])("checks %s read permission before user search", async (kind) => {
    const search = runtime();
    const authorize = vi.fn(allow);
    const app = createApp({ search, authorizeProjectPermission: authorize, log: vi.fn() });
    const response = await app.request(
      `/api/v1/projects/${projectId}/search/${kind}?q=needle`,
      {},
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(authorize).toHaveBeenCalledWith(
      expect.any(Request),
      env,
      projectId,
      kind === "tasks" ? { tasks: ["read"] } : { docs: ["read"] },
    );
    await expect(response.json()).resolves.toMatchObject({
      data: { items: [{ id: taskId, snippet: "needle" }] },
    });
  });
  it("denies user search without authentication", async () => {
    const search = runtime();
    const app = createApp({
      search,
      authorizeProjectPermission: async () => ({ authenticated: false }),
      log: vi.fn(),
    });
    expect(
      (await app.request(`/api/v1/projects/${projectId}/search/docs?q=secret`, {}, env)).status,
    ).toBe(401);
    expect(search.user).not.toHaveBeenCalled();
  });
  it("requires an Agent session separately from a user session", async () => {
    const search = runtime();
    const app = createApp({
      search,
      currentAgentSession: async () => null,
      authorizeProjectPermission: allow,
      log: vi.fn(),
    });
    expect(
      (
        await app.request(
          `/api/v1/agent/projects/${projectId}/search/tasks`,
          { method: "POST", body: '{"query":"needle"}' },
          env,
        )
      ).status,
    ).toBe(401);
    expect(search.agent).not.toHaveBeenCalled();
  });
  it.each([
    { query: "needle", ids: [otherId] },
    { query: "needle", limit: 51 },
    { query: "needle", cursor: "x".repeat(2049) },
  ])("rejects client scope expansion/invalid input %j", async (body) => {
    const search = runtime();
    const app = createApp({ search, currentAgentSession: async () => session(), log: vi.fn() });
    expect(
      (
        await app.request(
          `/api/v1/agent/projects/${projectId}/search/tasks`,
          { method: "POST", body: JSON.stringify(body) },
          env,
        )
      ).status,
    ).toBe(400);
    expect(search.agent).not.toHaveBeenCalled();
  });
  it("bounds an untrusted streaming body without a Content-Length", async () => {
    const search = runtime();
    const app = createApp({ search, currentAgentSession: async () => session(), log: vi.fn() });
    expect(
      (
        await app.request(
          `/api/v1/agent/projects/${projectId}/search/tasks`,
          { method: "POST", body: JSON.stringify({ query: "x".repeat(5000) }) },
          env,
        )
      ).status,
    ).toBe(400);
    expect(search.agent).not.toHaveBeenCalled();
  });
  it("returns scope denial with no query or result payload", async () => {
    const search = runtime();
    search.agent = vi.fn(async () => {
      throw new ProjectSearchError("SEARCH_SCOPE_DENIED");
    });
    const app = createApp({ search, currentAgentSession: async () => session(), log: vi.fn() });
    const response = await app.request(
      `/api/v1/agent/projects/${projectId}/search/tasks`,
      { method: "POST", body: '{"query":"secret"}' },
      env,
    );
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("secret");
  });
});
