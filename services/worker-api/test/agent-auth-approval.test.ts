import type { AgentAuthEvent } from "@better-auth/agent-auth";
import type { MemoryDB } from "@better-auth/memory-adapter";
import { memoryAdapter } from "@better-auth/memory-adapter";
import { betterAuth } from "better-auth/minimal";
import { describe, expect, it, vi } from "vitest";

import { pacaAgentApprovalGuard } from "../src/agent-auth/approval-guard";
import { pacaAgentAuth } from "../src/agent-auth/plugin";
import { createAuthOptions } from "../src/auth/runtime";
import type { AppBindings } from "../src/bindings";
import { pacaPermission } from "../src/permission/plugin";
import { PacaPermissionService, type PacaPermissionStore } from "../src/permission/service";

const BASE_URL = "https://auth.paca.test";
const TEST_SECRET = "test-only-secret-that-is-longer-than-thirty-two-characters";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const FUTURE = "2099-01-01T00:00:00.000Z";

type AgentMemoryDB = MemoryDB & {
  agentHost: Record<string, unknown>[];
  agent: Record<string, unknown>[];
  agentCapabilityGrant: Record<string, unknown>[];
  approvalRequest: Record<string, unknown>[];
};

function bindings(): AppBindings {
  return {
    BETTER_AUTH_SECRET: TEST_SECRET,
    BETTER_AUTH_URL: BASE_URL,
    ENVIRONMENT: "test",
    TRUSTED_ORIGINS: BASE_URL,
  } as AppBindings;
}

function database(): AgentMemoryDB {
  return {
    account: [],
    invitation: [],
    member: [],
    organization: [],
    session: [],
    user: [],
    verification: [],
    agentHost: [],
    agent: [],
    agentCapabilityGrant: [],
    approvalRequest: [],
  };
}

function permissionStore(allowed: boolean): PacaPermissionStore {
  return {
    listSystemGrants: async () => [],
    listOrganizationGrants: async () => [],
    listProjectGrants: async () =>
      allowed ? [{ resource: "agents", action: "approveGrant" }] : [],
    organizationExists: async () => true,
    findProjectOrganization: async () => "paca-default",
  };
}

function seedPendingAgent(db: AgentMemoryDB, organizationId = "paca-default") {
  const now = new Date();
  db.agentHost.push({
    id: "host-1",
    name: "Host",
    userId: null,
    defaultCapabilities: [],
    publicKey: JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "x" }),
    kid: null,
    jwksUrl: null,
    enrollmentTokenHash: null,
    enrollmentTokenExpiresAt: null,
    status: "active",
    activatedAt: now,
    expiresAt: null,
    lastUsedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  db.agent.push({
    id: "agent-1",
    name: "Agent",
    userId: null,
    hostId: "host-1",
    status: "pending",
    mode: "delegated",
    publicKey: JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "x" }),
    kid: null,
    jwksUrl: null,
    lastUsedAt: null,
    activatedAt: null,
    expiresAt: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
  });
  db.agentCapabilityGrant.push({
    id: "grant-1",
    agentId: "agent-1",
    capability: "project.read",
    deniedBy: null,
    grantedBy: null,
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
    status: "pending",
    reason: null,
    constraints: { organizationId, projectId: PROJECT_ID, validUntil: FUTURE },
  });
}

async function signedInApproval(allowed: boolean, organizationId = "paca-default") {
  const { auth, cookie, db } = await signedInAuth(allowed);
  seedPendingAgent(db, organizationId);

  const response = await auth.handler(
    new Request(`${BASE_URL}/api/auth/agent/approve-capability`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ agent_id: "agent-1", action: "approve" }),
    }),
  );
  return { db, response };
}

async function signedInAuth(
  allowed: boolean,
  onEvent?: (event: AgentAuthEvent) => void | Promise<void>,
) {
  const env = bindings();
  const db = database();
  const store = permissionStore(allowed);
  const service = new PacaPermissionService(store);
  const auth = betterAuth(
    createAuthOptions(
      memoryAdapter(db),
      env,
      pacaPermission({ service }),
      pacaAgentAuth(),
      pacaAgentApprovalGuard({
        permissionService: service,
        findProjectOrganization: (projectId) => store.findProjectOrganization(projectId),
        onEvent,
      }),
    ),
  );
  const signUp = await auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({
        email: "approver@paca.test",
        name: "Approver",
        password: "correct-horse-battery-staple",
      }),
    }),
  );
  const cookie = signUp.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Expected session cookie");
  return { auth, cookie, db };
}

function seedAutonomousAgent(db: AgentMemoryDB) {
  seedPendingAgent(db);
  const agent = db.agent[0];
  if (!agent) throw new Error("Expected seeded agent");
  agent.mode = "autonomous";
  agent.status = "active";
  agent.activatedAt = new Date();
  db.agentCapabilityGrant.length = 0;
}

describe("Paca Agent Auth approval guard", () => {
  it("allows Agent Auth to activate a scoped grant after Paca approveGrant authorization", async () => {
    const { db, response } = await signedInApproval(true);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "approved" });
    expect(db.agentCapabilityGrant).toEqual([
      expect.objectContaining({ id: "grant-1", status: "active" }),
    ]);
    expect(db.agent).toEqual([
      expect.objectContaining({ id: "agent-1", status: "active", userId: expect.any(String) }),
    ]);
  });

  it("rejects approval after the user's Paca approveGrant permission is removed", async () => {
    const { db, response } = await signedInApproval(false);

    expect(response.status).toBe(403);
    expect(db.agentCapabilityGrant).toEqual([
      expect.objectContaining({ id: "grant-1", status: "pending" }),
    ]);
  });

  it("rejects an Organization constraint that does not own the target Project", async () => {
    const { db, response } = await signedInApproval(true, "other-organization");

    expect(response.status).toBe(403);
    expect(db.agentCapabilityGrant).toEqual([
      expect.objectContaining({ id: "grant-1", status: "pending" }),
    ]);
  });

  it("allows a Project approver to grant and revoke a minimal autonomous capability", async () => {
    const onEvent = vi.fn();
    const { auth, cookie, db } = await signedInAuth(true, onEvent);
    seedAutonomousAgent(db);
    const constraints = {
      organizationId: "paca-default",
      projectId: PROJECT_ID,
      validUntil: FUTURE,
    };

    const grant = await auth.handler(
      new Request(`${BASE_URL}/api/auth/agent/grant-capability`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({
          agent_id: "agent-1",
          capabilities: [{ name: "project.read", constraints }],
        }),
      }),
    );

    expect(grant.status).toBe(200);
    expect(db.agentCapabilityGrant).toEqual([
      expect.objectContaining({
        agentId: "agent-1",
        capability: "project.read",
        constraints: JSON.stringify(constraints),
        status: "active",
        grantedBy: expect.any(String),
      }),
    ]);

    const revoke = await auth.handler(
      new Request(`${BASE_URL}/api/auth/paca-agent/revoke-capability`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({ agent_id: "agent-1", capabilities: ["project.read"] }),
      }),
    );

    expect(revoke.status).toBe(200);
    await expect(revoke.json()).resolves.toMatchObject({ revoked: ["project.read"] });
    expect(db.agentCapabilityGrant).toEqual([
      expect.objectContaining({ capability: "project.read", status: "revoked" }),
    ]);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "capability.revoked",
        actorType: "user",
        agentId: "agent-1",
      }),
    );
  });

  it("rejects autonomous grants without Project approval permission or complete constraints", async () => {
    const { auth, cookie, db } = await signedInAuth(false);
    seedAutonomousAgent(db);

    const denied = await auth.handler(
      new Request(`${BASE_URL}/api/auth/agent/grant-capability`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({
          agent_id: "agent-1",
          capabilities: [
            {
              name: "project.read",
              constraints: {
                organizationId: "paca-default",
                projectId: PROJECT_ID,
                validUntil: FUTURE,
              },
            },
          ],
        }),
      }),
    );
    expect(denied.status).toBe(403);
    expect(db.agentCapabilityGrant).toEqual([]);

    const invalid = await auth.handler(
      new Request(`${BASE_URL}/api/auth/agent/grant-capability`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({
          agent_id: "agent-1",
          capabilities: [{ name: "project.read", constraints: { projectId: PROJECT_ID } }],
        }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(db.agentCapabilityGrant).toEqual([]);
  });
});
