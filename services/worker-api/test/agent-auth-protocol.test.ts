import type { MemoryDB } from "@better-auth/memory-adapter";
import { memoryAdapter } from "@better-auth/memory-adapter";
import type { BetterAuthOptions } from "better-auth";
import { betterAuth } from "better-auth/minimal";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";

import { pacaAgentApprovalGuard } from "../src/agent-auth/approval-guard";
import { pacaAgentAuth } from "../src/agent-auth/plugin";
import { createAuthOptions } from "../src/auth/runtime";
import type { AppBindings } from "../src/bindings";
import { pacaPermission } from "../src/permission/plugin";
import { PacaPermissionService, type PacaPermissionStore } from "../src/permission/service";

const BASE_URL = "https://auth.paca.test";
const TEST_SECRET = "test-only-secret-that-is-longer-than-thirty-two-characters";
const ORGANIZATION_ID = "paca-default";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const AUTONOMOUS_ENROLLMENT_SECRET =
  "autonomous-test-enrollment-secret-with-more-than-32-characters";

type JsonRecord = Record<string, unknown>;

type AgentMemoryDB = MemoryDB & {
  agentHost: JsonRecord[];
  agent: JsonRecord[];
  agentCapabilityGrant: JsonRecord[];
  approvalRequest: JsonRecord[];
};

type SigningIdentity = {
  privateKey: CryptoKey;
  publicJwk: JWK;
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

function permissionStore(): PacaPermissionStore {
  return {
    listSystemGrants: async () => [],
    listOrganizationGrants: async () => [],
    listProjectGrants: async () => [{ resource: "agents", action: "approveGrant" }],
    organizationExists: async () => true,
    findProjectOrganization: async () => ORGANIZATION_ID,
  };
}

function memorySecondaryStorage(): NonNullable<BetterAuthOptions["secondaryStorage"]> {
  const values = new Map<string, { value: string; expiresAt: number | null }>();
  const read = (key: string) => {
    const entry = values.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      values.delete(key);
      return null;
    }
    return entry.value;
  };

  return {
    get: async (key) => read(key),
    getAndDelete: async (key) => {
      const value = read(key);
      values.delete(key);
      return value;
    },
    increment: async (key, ttl) => {
      const current = Number(read(key) ?? "0");
      const value = Number.isSafeInteger(current) && current >= 0 ? current + 1 : 1;
      values.set(key, {
        value: String(value),
        expiresAt: Date.now() + Math.max(1, ttl) * 1_000,
      });
      return value;
    },
    set: async (key, value, ttl) => {
      values.set(key, {
        value,
        expiresAt: ttl === undefined ? null : Date.now() + Math.max(1, ttl) * 1_000,
      });
    },
    delete: async (key) => {
      values.delete(key);
    },
  };
}

function sessionCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  const match = setCookie?.match(/(?:^|,\s*)([^=;,]*session_token)=[^;,]+/i);
  if (!match?.[0]) throw new Error("Expected Better Auth session cookie");
  return match[0].replace(/^,\s*/, "").split(";")[0] ?? "";
}

async function json(response: Response): Promise<JsonRecord> {
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected JSON object");
  }
  return value as JsonRecord;
}

function post(
  path: string,
  body: JsonRecord,
  options: { cookie?: string; bearer?: string; headers?: Record<string, string> } = {},
): Request {
  const headers = new Headers({ "content-type": "application/json", origin: BASE_URL });
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.bearer) headers.set("authorization", `Bearer ${options.bearer}`);
  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
  return new Request(`${BASE_URL}/api/auth${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function signingIdentity(): Promise<SigningIdentity> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA");
  return { privateKey, publicJwk: await exportJWK(publicKey) };
}

async function signedJwt(options: {
  identity: SigningIdentity;
  type: "host+jwt" | "agent+jwt";
  issuer: string;
  audience: string;
  subject?: string;
  jti: string;
  capabilities?: string[];
  extra?: JsonRecord;
  issuedAt?: number;
  expiresAt?: number;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  let jwt = new SignJWT({
    ...options.extra,
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
  })
    .setProtectedHeader({ alg: "EdDSA", typ: options.type })
    .setIssuer(options.issuer)
    .setAudience(options.audience)
    .setJti(options.jti)
    .setIssuedAt(options.issuedAt ?? now)
    .setExpirationTime(options.expiresAt ?? now + 45);
  if (options.subject) jwt = jwt.setSubject(options.subject);
  return jwt.sign(options.identity.privateKey);
}

type ProtocolHarness = Awaited<ReturnType<typeof createProtocolHarness>>;

async function createProtocolHarness() {
  const db = database();
  const env = bindings();
  const store = permissionStore();
  const permissionService = new PacaPermissionService(store);
  const onExecute = vi.fn(async ({ capability, arguments: args }) => ({ capability, args }));
  const auth = betterAuth(
    createAuthOptions(
      memoryAdapter(db),
      env,
      pacaPermission({ service: permissionService }),
      pacaAgentAuth({ onExecute }),
      pacaAgentApprovalGuard({
        permissionService,
        findProjectOrganization: (projectId) => store.findProjectOrganization(projectId),
      }),
      memorySecondaryStorage(),
    ),
  );

  const signUp = await auth.handler(
    post("/sign-up/email", {
      email: "agent-owner@paca.test",
      name: "Agent Owner",
      password: "correct-horse-battery-staple",
    }),
  );
  expect(signUp.status).toBe(200);
  const cookie = sessionCookie(signUp);

  const discovery = await auth.api.getAgentConfiguration();
  const defaultLocation = discovery.default_location;
  const hostIdentity = await signingIdentity();
  const agentIdentity = await signingIdentity();

  const createHostResponse = await auth.handler(
    post("/host/create", { name: "Protocol Test Host" }, { cookie }),
  );
  expect(createHostResponse.status).toBe(200);
  const createdHost = await json(createHostResponse);
  expect(createdHost).toMatchObject({ status: "pending_enrollment" });
  const hostId = String(createdHost.hostId);
  const enrollmentToken = String(createdHost.enrollmentToken);

  const enrollHostResponse = await auth.handler(
    post("/host/enroll", {
      token: enrollmentToken,
      public_key: hostIdentity.publicJwk as JsonRecord,
      name: "Enrolled Protocol Host",
    }),
  );
  expect(enrollHostResponse.status).toBe(200);
  await expect(enrollHostResponse.json()).resolves.toMatchObject({
    hostId,
    status: "active",
  });

  const constraints = {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    validUntil: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
  const hostJwt = await signedJwt({
    identity: hostIdentity,
    type: "host+jwt",
    issuer: hostId,
    audience: defaultLocation,
    jti: "register-agent-1",
    extra: { agent_public_key: agentIdentity.publicJwk as JsonRecord },
  });
  const registerResponse = await auth.handler(
    post(
      "/agent/register",
      {
        name: "Protocol Test Agent",
        mode: "delegated",
        capabilities: [{ name: "project.read", constraints }],
      },
      { bearer: hostJwt },
    ),
  );
  expect(registerResponse.status).toBe(200);
  const registeredAgent = await json(registerResponse);
  expect(registeredAgent).toMatchObject({ host_id: hostId, status: "pending" });
  const agentId = String(registeredAgent.agent_id);
  const approval = registeredAgent.approval as JsonRecord;
  const userCode = String(approval.user_code);

  const approveResponse = await auth.handler(
    post(
      "/agent/approve-capability",
      { agent_id: agentId, user_code: userCode, action: "approve" },
      { cookie },
    ),
  );
  expect(approveResponse.status).toBe(200);
  await expect(approveResponse.json()).resolves.toMatchObject({ status: "approved" });

  return {
    auth,
    db,
    cookie,
    onExecute,
    defaultLocation,
    hostId,
    agentId,
    agentIdentity,
    constraints,
  };
}

async function agentJwt(
  harness: ProtocolHarness,
  overrides: {
    jti: string;
    audience?: string;
    capabilities?: string[];
    issuedAt?: number;
    expiresAt?: number;
  },
) {
  return signedJwt({
    identity: harness.agentIdentity,
    type: "agent+jwt",
    issuer: harness.hostId,
    subject: harness.agentId,
    audience: overrides.audience ?? harness.defaultLocation,
    jti: overrides.jti,
    capabilities: overrides.capabilities ?? ["project.read"],
    issuedAt: overrides.issuedAt,
    expiresAt: overrides.expiresAt,
  });
}

async function execute(
  harness: ProtocolHarness,
  token: string,
  capability = "project.read",
  args: JsonRecord = harness.constraints,
) {
  return harness.auth.handler(
    post("/capability/execute", { capability, arguments: args }, { bearer: token }),
  );
}

describe("Better Auth Agent Auth protocol", () => {
  it("fails configuration instead of silently enabling a weak autonomous bootstrap secret", () => {
    expect(() => pacaAgentAuth({ autonomousHostEnrollmentSecret: "too-short" })).toThrow(
      "AUTONOMOUS_HOST_ENROLLMENT_SECRET_TOO_SHORT",
    );
  });

  it("completes Host enrollment, delegated registration, approval, JWT execution, and replay rejection", async () => {
    const harness = await createProtocolHarness();
    const token = await agentJwt(harness, { jti: "execute-once" });

    const first = await execute(harness, token);
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      data: { capability: "project.read", args: harness.constraints },
    });
    expect(harness.onExecute).toHaveBeenCalledTimes(1);

    const replay = await execute(harness, token);
    expect(replay.status).toBe(401);
    await expect(replay.json()).resolves.toMatchObject({ error: "jti_replay" });
    expect(harness.onExecute).toHaveBeenCalledTimes(1);
  });

  it("reactivates a durable Agent after the sliding 24-hour grant horizon", async () => {
    const harness = await createProtocolHarness();
    const agent = harness.db.agent.find((candidate) => candidate.id === harness.agentId);
    if (!agent) throw new Error("Expected registered protocol Agent");
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    agent.createdAt = twoDaysAgo;
    agent.activatedAt = twoDaysAgo;
    agent.expiresAt = new Date(Date.now() - 60_000);

    const staleGrantToken = await agentJwt(harness, { jti: "reactivate-durable-agent" });
    const staleGrantResponse = await execute(harness, staleGrantToken);

    expect(staleGrantResponse.status).toBe(403);
    await expect(staleGrantResponse.json()).resolves.toMatchObject({
      error: "capability_not_granted",
    });
    expect(agent.status).toBe("active");
    expect(new Date(String(agent.expiresAt)).getTime()).toBeGreaterThan(Date.now());

    const refreshedGrant = await harness.auth.handler(
      post(
        "/agent/grant-capability",
        {
          agent_id: harness.agentId,
          capabilities: [{ name: "project.read", constraints: harness.constraints }],
        },
        { cookie: harness.cookie },
      ),
    );
    expect(refreshedGrant.status).toBe(200);

    const refreshedToken = await agentJwt(harness, { jti: "execute-reactivated-agent" });
    const response = await execute(harness, refreshedToken);
    expect(response.status).toBe(200);
    expect(harness.onExecute).toHaveBeenCalledTimes(1);
  });

  it("rejects the wrong audience and an expired JWT before execution", async () => {
    const harness = await createProtocolHarness();
    const wrongAudience = await agentJwt(harness, {
      jti: "wrong-audience",
      audience: "https://wrong.paca.test/api/auth/capability/execute",
    });
    const wrongAudienceResponse = await execute(harness, wrongAudience);
    expect(wrongAudienceResponse.status).toBe(401);

    const now = Math.floor(Date.now() / 1_000);
    const expired = await agentJwt(harness, {
      jti: "expired-jwt",
      issuedAt: now - 600,
      expiresAt: now - 300,
    });
    const expiredResponse = await execute(harness, expired);
    expect(expiredResponse.status).toBe(401);
    expect(harness.onExecute).not.toHaveBeenCalled();
  });

  it("rejects a missing capability grant and a wrong Project constraint", async () => {
    const harness = await createProtocolHarness();
    const withoutGrant = await agentJwt(harness, {
      jti: "missing-grant",
      capabilities: ["task.read"],
    });
    const missingGrantResponse = await execute(
      harness,
      withoutGrant,
      "task.read",
      harness.constraints,
    );
    expect(missingGrantResponse.status).toBe(403);
    await expect(missingGrantResponse.json()).resolves.toMatchObject({
      error: "capability_not_granted",
    });

    const wrongProject = await agentJwt(harness, { jti: "wrong-project" });
    const wrongProjectResponse = await execute(harness, wrongProject, "project.read", {
      ...harness.constraints,
      projectId: OTHER_PROJECT_ID,
    });
    expect(wrongProjectResponse.status).toBe(403);
    await expect(wrongProjectResponse.json()).resolves.toMatchObject({
      error: "constraint_violated",
    });
    expect(harness.onExecute).not.toHaveBeenCalled();
  });

  it("rejects an expired active Grant even when the JWT still names the capability", async () => {
    const harness = await createProtocolHarness();
    const grant = harness.db.agentCapabilityGrant.find(
      (candidate) =>
        candidate.agentId === harness.agentId && candidate.capability === "project.read",
    );
    if (!grant) throw new Error("Expected active protocol grant");
    grant.expiresAt = new Date(Date.now() - 60_000);

    const token = await agentJwt(harness, { jti: "expired-grant" });
    const response = await execute(harness, token);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "capability_not_granted",
    });
    expect(harness.onExecute).not.toHaveBeenCalled();
  });

  it("enrolls an autonomous Host only with the bootstrap secret and honors grant revocation", async () => {
    const db = database();
    const env = bindings();
    const store = permissionStore();
    const permissionService = new PacaPermissionService(store);
    const onExecute = vi.fn(async ({ capability, arguments: args }) => ({ capability, args }));
    const auth = betterAuth(
      createAuthOptions(
        memoryAdapter(db),
        env,
        pacaPermission({ service: permissionService }),
        pacaAgentAuth({
          autonomousHostEnrollmentSecret: AUTONOMOUS_ENROLLMENT_SECRET,
          onExecute,
        }),
        pacaAgentApprovalGuard({
          permissionService,
          findProjectOrganization: (projectId) => store.findProjectOrganization(projectId),
        }),
        memorySecondaryStorage(),
      ),
    );
    const discovery = await auth.api.getAgentConfiguration();
    expect(discovery.modes).toContain("autonomous");

    const signUp = await auth.handler(
      post("/sign-up/email", {
        email: "autonomous-approver@paca.test",
        name: "Autonomous Approver",
        password: "correct-horse-battery-staple",
      }),
    );
    expect(signUp.status).toBe(200);
    const cookie = sessionCookie(signUp);
    const hostIdentity = await signingIdentity();
    const agentIdentity = await signingIdentity();
    const hostJwt = await signedJwt({
      identity: hostIdentity,
      type: "host+jwt",
      issuer: "autonomous-bootstrap-host",
      audience: discovery.default_location,
      jti: "autonomous-register",
      extra: {
        host_public_key: hostIdentity.publicJwk as JsonRecord,
        agent_public_key: agentIdentity.publicJwk as JsonRecord,
        host_name: "Autonomous Protocol Host",
      },
    });

    const rejected = await auth.handler(
      post(
        "/agent/register",
        { name: "Rejected Autonomous Agent", mode: "autonomous" },
        {
          bearer: hostJwt,
          headers: { "x-paca-autonomous-host-enrollment": "wrong-secret" },
        },
      ),
    );
    expect(rejected.status).toBe(403);

    const acceptedHostJwt = await signedJwt({
      identity: hostIdentity,
      type: "host+jwt",
      issuer: "autonomous-bootstrap-host",
      audience: discovery.default_location,
      jti: "autonomous-register-accepted",
      extra: {
        host_public_key: hostIdentity.publicJwk as JsonRecord,
        agent_public_key: agentIdentity.publicJwk as JsonRecord,
        host_name: "Autonomous Protocol Host",
      },
    });
    const registered = await auth.handler(
      post(
        "/agent/register",
        { name: "Autonomous Protocol Agent", mode: "autonomous" },
        {
          bearer: acceptedHostJwt,
          headers: {
            "x-paca-autonomous-host-enrollment": AUTONOMOUS_ENROLLMENT_SECRET,
          },
        },
      ),
    );
    expect(registered.status).toBe(200);
    const agent = await json(registered);
    expect(agent).toMatchObject({ mode: "autonomous", status: "active" });
    const agentId = String(agent.agent_id);
    const hostId = String(agent.host_id);
    expect(db.agentHost).toEqual([
      expect.objectContaining({ id: hostId, userId: null, status: "active" }),
    ]);

    const constraints = {
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      validUntil: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
    const grant = await auth.handler(
      post(
        "/agent/grant-capability",
        {
          agent_id: agentId,
          capabilities: [{ name: "project.read", constraints }],
        },
        { cookie },
      ),
    );
    expect(grant.status).toBe(200);
    expect(db.agentCapabilityGrant).toEqual([
      expect.objectContaining({
        agentId,
        capability: "project.read",
        status: "active",
        grantedBy: expect.any(String),
      }),
    ]);

    const executeToken = await signedJwt({
      identity: agentIdentity,
      type: "agent+jwt",
      issuer: hostId,
      subject: agentId,
      audience: discovery.default_location,
      jti: "autonomous-execute",
      capabilities: ["project.read"],
    });
    const executed = await auth.handler(
      post(
        "/capability/execute",
        { capability: "project.read", arguments: constraints },
        { bearer: executeToken },
      ),
    );
    expect(executed.status).toBe(200);
    expect(onExecute).toHaveBeenCalledOnce();

    const revoked = await auth.handler(
      post(
        "/paca-agent/revoke-capability",
        { agent_id: agentId, capabilities: ["project.read"] },
        { cookie },
      ),
    );
    expect(revoked.status).toBe(200);
    expect(db.agentCapabilityGrant).toEqual([
      expect.objectContaining({ capability: "project.read", status: "revoked" }),
    ]);

    const afterRevokeToken = await signedJwt({
      identity: agentIdentity,
      type: "agent+jwt",
      issuer: hostId,
      subject: agentId,
      audience: discovery.default_location,
      jti: "autonomous-after-revoke",
      capabilities: ["project.read"],
    });
    const afterRevoke = await auth.handler(
      post(
        "/capability/execute",
        { capability: "project.read", arguments: constraints },
        { bearer: afterRevokeToken },
      ),
    );
    expect(afterRevoke.status).toBe(403);
    await expect(afterRevoke.json()).resolves.toMatchObject({
      error: "grant_revoked",
    });
    expect(onExecute).toHaveBeenCalledOnce();
  });
});
