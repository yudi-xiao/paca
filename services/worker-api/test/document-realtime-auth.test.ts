import type { AgentSession, CapabilityConstraints } from "@better-auth/agent-auth";
import { describe, expect, it, vi } from "vitest";

import type { CurrentUserSession } from "../src/auth/runtime";
import type { AppBindings } from "../src/bindings";
import {
  authorizeDocumentConnection,
  type DocumentRealtimeAuthDependencies,
} from "../src/document/realtime-auth";
import {
  DOCUMENT_CONTEXT_HEADER,
  decodeDocumentConnectionState,
} from "../src/document/realtime-protocol";
import type { PermissionGrant } from "../src/permission/statement";

const ORGANIZATION_ID = "organization-1";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
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
  return new Request(`${ORIGIN}/ws/parties/document-party/${DOCUMENT_ID}`, {
    headers: { upgrade: "websocket", ...headers },
  });
}

function userSession(): CurrentUserSession {
  return {
    id: "session-1",
    user: {
      id: "user-1",
      name: "User",
      email: "user@paca.test",
      emailVerified: true,
      image: null,
      createdAt: "2026-08-01T00:00:00.000Z",
    },
    expiresAt: "2026-09-07T00:00:00.000Z",
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
      name: "Document Agent",
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

function dependencies(
  overrides: Partial<DocumentRealtimeAuthDependencies> = {},
): DocumentRealtimeAuthDependencies {
  return {
    now: () => NOW,
    readAgentSession: vi.fn(async () => null),
    readDocumentScope: vi.fn(async () => ({
      documentId: DOCUMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    })),
    readProjectGrants: vi.fn(async () => null),
    readUserSession: vi.fn(async () => null),
    ...overrides,
  };
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { code: string }).code;
}

describe("document realtime authorization", () => {
  it("derives user read/write access and replaces spoofed connection context", async () => {
    const grants: PermissionGrant[] = [
      { resource: "docs", action: "read" },
      { resource: "docs", action: "write" },
    ];
    const result = await authorizeDocumentConnection(
      websocketRequest({ origin: ORIGIN, [DOCUMENT_CONTEXT_HEADER]: "spoofed" }),
      { className: "DocumentParty", name: DOCUMENT_ID },
      bindings(),
      dependencies({
        readUserSession: vi.fn(async () => userSession()),
        readProjectGrants: vi.fn(async () => grants),
      }),
    );

    expect(result).toBeInstanceOf(Request);
    const state = decodeDocumentConnectionState(
      (result as Request).headers.get(DOCUMENT_CONTEXT_HEADER),
    );
    expect(state).toMatchObject({
      actorType: "user",
      actorId: "user-1",
      sessionId: "session-1",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      documentId: DOCUMENT_ID,
      canWrite: true,
      expiresAt: NOW + 5 * 60_000,
    });
    expect(state?.permissionVersion).toMatch(/^[a-f0-9]{64}$/);
    expect((result as Request).headers.get(DOCUMENT_CONTEXT_HEADER)).not.toBe("spoofed");
  });

  it("admits a docs.read user as read-only and denies missing read permission", async () => {
    const readGrants: PermissionGrant[] = [{ resource: "docs", action: "read" }];
    const unrelatedGrants: PermissionGrant[] = [{ resource: "tasks", action: "read" }];
    const readOnly = await authorizeDocumentConnection(
      websocketRequest({ origin: ORIGIN }),
      { className: "DocumentParty", name: DOCUMENT_ID },
      bindings(),
      dependencies({
        readUserSession: vi.fn(async () => userSession()),
        readProjectGrants: vi.fn(async () => readGrants),
      }),
    );
    const denied = await authorizeDocumentConnection(
      websocketRequest({ origin: ORIGIN }),
      { className: "DocumentParty", name: DOCUMENT_ID },
      bindings(),
      dependencies({
        readUserSession: vi.fn(async () => userSession()),
        readProjectGrants: vi.fn(async () => unrelatedGrants),
      }),
    );

    expect(
      decodeDocumentConnectionState((readOnly as Request).headers.get(DOCUMENT_CONTEXT_HEADER)),
    ).toMatchObject({ canWrite: false });
    expect((denied as Response).status).toBe(403);
    await expect(errorCode(denied as Response)).resolves.toBe("DOCUMENT_PERMISSION_DENIED");
  });

  it("admits an Agent only with an exact active document.read grant and keeps it read-only", async () => {
    const validUntil = "2026-09-01T00:00:00.000Z";
    const session = agentSession([
      {
        capability: "document.read",
        constraints: {
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          documentId: DOCUMENT_ID,
          validUntil,
        },
      },
    ]);
    const result = await authorizeDocumentConnection(
      websocketRequest({ authorization: `Bearer ${jwt(Math.floor((NOW + 60_000) / 1_000))}` }),
      { className: "DocumentParty", name: DOCUMENT_ID },
      bindings(),
      dependencies({ readAgentSession: vi.fn(async () => session) }),
    );

    expect(result).toBeInstanceOf(Request);
    expect(
      decodeDocumentConnectionState((result as Request).headers.get(DOCUMENT_CONTEXT_HEADER)),
    ).toMatchObject({
      actorType: "agent",
      actorId: "agent-1",
      canWrite: false,
      expiresAt: NOW + 60_000,
    });
  });

  it("rejects a mismatched Agent grant, an untrusted browser origin, and a missing document", async () => {
    const session = agentSession([
      {
        capability: "document.read",
        constraints: {
          organizationId: ORGANIZATION_ID,
          projectId: OTHER_PROJECT_ID,
          documentId: DOCUMENT_ID,
          validUntil: "2026-09-01T00:00:00.000Z",
        },
      },
    ]);
    const agentResult = await authorizeDocumentConnection(
      websocketRequest({ authorization: `Bearer ${jwt(Math.floor((NOW + 60_000) / 1_000))}` }),
      { className: "DocumentParty", name: DOCUMENT_ID },
      bindings(),
      dependencies({ readAgentSession: vi.fn(async () => session) }),
    );
    const originResult = await authorizeDocumentConnection(
      websocketRequest({ origin: "https://attacker.example" }),
      { className: "DocumentParty", name: DOCUMENT_ID },
      bindings(),
      dependencies({ readUserSession: vi.fn(async () => userSession()) }),
    );
    const missingResult = await authorizeDocumentConnection(
      websocketRequest({ origin: ORIGIN }),
      { className: "DocumentParty", name: DOCUMENT_ID },
      bindings(),
      dependencies({
        readUserSession: vi.fn(async () => userSession()),
        readDocumentScope: vi.fn(async () => null),
      }),
    );

    expect((agentResult as Response).status).toBe(403);
    await expect(errorCode(agentResult as Response)).resolves.toBe("DOCUMENT_AGENT_GRANT_DENIED");
    expect((originResult as Response).status).toBe(403);
    await expect(errorCode(originResult as Response)).resolves.toBe("DOCUMENT_ORIGIN_DENIED");
    expect((missingResult as Response).status).toBe(404);
    await expect(errorCode(missingResult as Response)).resolves.toBe("DOCUMENT_NOT_FOUND");
  });
});
