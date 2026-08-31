import type { AgentSession, CapabilityConstraints } from "@better-auth/agent-auth";
import { describe, expect, it, vi } from "vitest";

import type { CurrentUserSession } from "../src/auth/runtime";
import type { AppBindings } from "../src/bindings";
import type { PermissionGrant } from "../src/permission/statement";
import { authorizeRealtimeConnection, type RealtimeAuthDependencies } from "../src/realtime/auth";
import { decodeConnectionState, REALTIME_CONTEXT_HEADER } from "../src/realtime/protocol";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const TASK_ID = "33333333-3333-4333-8333-333333333333";
const DOCUMENT_ID = "44444444-4444-4444-8444-444444444444";
const NOW = Date.parse("2026-08-31T00:00:00.000Z");
const ORIGIN = "https://paca.howlearnwood.com";

function bindings(): AppBindings {
  return {
    ENVIRONMENT: "test",
    BETTER_AUTH_URL: ORIGIN,
    TRUSTED_ORIGINS: ORIGIN,
  } as AppBindings;
}

function websocketRequest(headers: HeadersInit = {}): Request {
  return new Request(`${ORIGIN}/ws/parties/project-party/${PROJECT_ID}`, {
    headers: { upgrade: "websocket", ...headers },
  });
}

function userSession(overrides: Partial<CurrentUserSession> = {}): CurrentUserSession {
  return {
    user: {
      id: "user-1",
      name: "User",
      email: "user@paca.test",
      emailVerified: true,
      image: null,
      createdAt: "2026-08-01T00:00:00.000Z",
    },
    expiresAt: "2026-09-07T00:00:00.000Z",
    ...overrides,
  };
}

function agentSession(
  grants: Array<{ capability: string; constraints: CapabilityConstraints }>,
): AgentSession {
  const timestamp = new Date("2026-08-31T00:00:00.000Z");
  return {
    type: "autonomous",
    agentId: "agent-1",
    userId: "user-1",
    agent: {
      id: "agent-1",
      name: "Realtime Agent",
      mode: "autonomous",
      capabilityGrants: grants.map((grant) => ({
        ...grant,
        grantedBy: "approver-1",
        status: "active",
      })),
      hostId: "host-1",
      createdAt: timestamp,
      activatedAt: timestamp,
      metadata: null,
    },
    host: { id: "host-1", userId: "user-1", status: "active" },
    user: { id: "user-1", name: "User", email: "user@paca.test" },
  };
}

function jwt(exp: number): string {
  const payload = btoa(JSON.stringify({ exp }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `header.${payload}.signature`;
}

function dependencies(overrides: Partial<RealtimeAuthDependencies> = {}): RealtimeAuthDependencies {
  return {
    now: () => NOW,
    readAgentSession: vi.fn(async () => null),
    readProjectGrants: vi.fn(async () => null),
    readUserSession: vi.fn(async () => null),
    ...overrides,
  };
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { code: string }).code;
}

describe("realtime connection authorization", () => {
  it("derives user project namespaces from Paca permissions and replaces spoofed context", async () => {
    const grants: PermissionGrant[] = [
      { resource: "tasks", action: "read" },
      { resource: "docs", action: "*" },
    ];
    const result = await authorizeRealtimeConnection(
      websocketRequest({ origin: ORIGIN, [REALTIME_CONTEXT_HEADER]: "spoofed" }),
      { className: "ProjectParty", name: PROJECT_ID },
      bindings(),
      dependencies({
        readUserSession: vi.fn(async () => userSession()),
        readProjectGrants: vi.fn(async () => grants),
      }),
    );

    expect(result).toBeInstanceOf(Request);
    const state = decodeConnectionState((result as Request).headers.get(REALTIME_CONTEXT_HEADER));
    expect(state).toMatchObject({
      actorType: "user",
      actorId: "user-1",
      roomType: "project",
      roomId: PROJECT_ID,
      namespaces: ["tasks", "docs"],
    });
    expect(state?.expiresAt).toBe(NOW + 5 * 60_000);
    expect((result as Request).headers.get(REALTIME_CONTEXT_HEADER)).not.toBe("spoofed");
  });

  it("rejects cross-origin browser upgrades and cross-user rooms", async () => {
    const deps = dependencies({ readUserSession: vi.fn(async () => userSession()) });
    const originResult = await authorizeRealtimeConnection(
      websocketRequest({ origin: "https://attacker.example" }),
      { className: "ProjectParty", name: PROJECT_ID },
      bindings(),
      deps,
    );
    const userResult = await authorizeRealtimeConnection(
      websocketRequest({ origin: ORIGIN }),
      { className: "UserParty", name: "user-2" },
      bindings(),
      deps,
    );

    expect(originResult).toBeInstanceOf(Response);
    expect((originResult as Response).status).toBe(403);
    await expect(errorCode(originResult as Response)).resolves.toBe("REALTIME_ORIGIN_DENIED");
    expect((userResult as Response).status).toBe(403);
    await expect(errorCode(userResult as Response)).resolves.toBe("REALTIME_USER_SCOPE_DENIED");
  });

  it("rejects a user without readable project namespaces", async () => {
    const writeOnlyGrants: PermissionGrant[] = [{ resource: "tasks", action: "write" }];
    const result = await authorizeRealtimeConnection(
      websocketRequest({ origin: ORIGIN }),
      { className: "ProjectParty", name: PROJECT_ID },
      bindings(),
      dependencies({
        readUserSession: vi.fn(async () => userSession()),
        readProjectGrants: vi.fn(async () => writeOnlyGrants),
      }),
    );

    expect((result as Response).status).toBe(403);
    await expect(errorCode(result as Response)).resolves.toBe("REALTIME_PROJECT_PERMISSION_DENIED");
  });

  it("limits Agent project connections to exact active read grants and JWT lifetime", async () => {
    const validUntil = "2026-09-01T00:00:00.000Z";
    const session = agentSession([
      {
        capability: "task.read",
        constraints: { projectId: PROJECT_ID, taskId: TASK_ID, validUntil },
      },
      {
        capability: "document.read",
        constraints: { projectId: PROJECT_ID, documentId: DOCUMENT_ID, validUntil },
      },
      {
        capability: "task.read",
        constraints: { projectId: OTHER_PROJECT_ID, taskId: OTHER_PROJECT_ID, validUntil },
      },
    ]);
    const result = await authorizeRealtimeConnection(
      websocketRequest({ authorization: `Bearer ${jwt(Math.floor((NOW + 60_000) / 1_000))}` }),
      { className: "ProjectParty", name: PROJECT_ID },
      bindings(),
      dependencies({ readAgentSession: vi.fn(async () => session) }),
    );

    expect(result).toBeInstanceOf(Request);
    expect(
      decodeConnectionState((result as Request).headers.get(REALTIME_CONTEXT_HEADER)),
    ).toMatchObject({
      actorType: "agent",
      actorId: "agent-1",
      namespaces: ["tasks", "docs"],
      taskIds: [TASK_ID],
      documentIds: [DOCUMENT_ID],
      expiresAt: NOW + 60_000,
    });
  });

  it("denies broad or mismatched Agent grants and never admits Agents to UserParty", async () => {
    const validUntil = "2026-09-01T00:00:00.000Z";
    const session = agentSession([
      { capability: "task.read", constraints: { projectId: PROJECT_ID, validUntil } },
    ]);
    const request = websocketRequest({
      authorization: `Bearer ${jwt(Math.floor((NOW + 60_000) / 1_000))}`,
    });
    const projectResult = await authorizeRealtimeConnection(
      request,
      { className: "ProjectParty", name: PROJECT_ID },
      bindings(),
      dependencies({ readAgentSession: vi.fn(async () => session) }),
    );
    const userResult = await authorizeRealtimeConnection(
      request,
      { className: "UserParty", name: "agent-1" },
      bindings(),
      dependencies({ readAgentSession: vi.fn(async () => session) }),
    );

    expect((projectResult as Response).status).toBe(403);
    await expect(errorCode(projectResult as Response)).resolves.toBe("REALTIME_AGENT_GRANT_DENIED");
    expect((userResult as Response).status).toBe(401);
    await expect(errorCode(userResult as Response)).resolves.toBe("REALTIME_USER_SESSION_REQUIRED");
  });

  it("rejects non-WebSocket requests before reading authentication state", async () => {
    const deps = dependencies();
    const result = await authorizeRealtimeConnection(
      new Request(`${ORIGIN}/ws/parties/project-party/${PROJECT_ID}`),
      { className: "ProjectParty", name: PROJECT_ID },
      bindings(),
      deps,
    );

    expect((result as Response).status).toBe(400);
    await expect(errorCode(result as Response)).resolves.toBe("REALTIME_WEBSOCKET_REQUIRED");
    expect(deps.readUserSession).not.toHaveBeenCalled();
  });
});
