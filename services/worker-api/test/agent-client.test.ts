import { describe, expect, it, vi } from "vitest";

import { executeAgentCapability, registerDelegatedAgent } from "../src/agent-auth/agent-client";
import { generateAgentHostIdentity } from "../src/agent-auth/host-enrollment";

const origin = "https://paca.howlearnwood.com";
const hostId = "host-1";
const projectId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";

async function verifyJwt(jwt: string, publicJwk: JsonWebKey) {
  const [header, payload, signature] = jwt.split(".");
  if (!header || !payload || !signature) return false;
  const key = await crypto.subtle.importKey("jwk", publicJwk, { name: "Ed25519" }, false, [
    "verify",
  ]);
  return crypto.subtle.verify(
    "Ed25519",
    key,
    Buffer.from(signature, "base64url"),
    new TextEncoder().encode(`${header}.${payload}`),
  );
}

function jwtPayload(jwt: string): Record<string, unknown> {
  const payload = jwt.split(".")[1];
  return JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

describe("delegated Agent client", () => {
  it("registers with a signed Host JWT and never uploads the Agent private key", async () => {
    const hostIdentity = await generateAgentHostIdentity();
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      const jwt = authorization.replace(/^Bearer /, "");
      expect(await verifyJwt(jwt, hostIdentity.publicKey)).toBe(true);
      expect(jwtPayload(jwt)).toMatchObject({
        iss: hostId,
        aud: `${origin}/api/auth/capability/execute`,
      });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const capabilities = body.capabilities as Array<Record<string, unknown>>;
      expect(capabilities.map(({ name }) => name)).toEqual([
        "project.read",
        "task.read",
        "task.write",
        "task.create",
      ]);
      expect(JSON.stringify(body)).not.toContain('"d"');
      return Response.json({
        agent_id: "agent-1",
        host_id: hostId,
        status: "pending",
        approval: {
          user_code: "ABCD-EFGH",
          verification_uri: `${origin}/device/capabilities`,
          verification_uri_complete: `${origin}/device/capabilities?agent_id=agent-1&code=ABCD-EFGH`,
          expires_in: 300,
        },
      });
    });

    const registration = await registerDelegatedAgent({
      hostConfig: {
        version: 1,
        providerOrigin: origin,
        issuer: `${origin}/api/auth`,
        defaultLocation: `${origin}/api/auth/capability/execute`,
        hostId,
        hostName: "Host",
        keyAlgorithm: "Ed25519",
        publicKey: hostIdentity.publicKey,
        privateKey: hostIdentity.privateKey,
        enrolledAt: "2026-08-31T00:00:00.000Z",
      },
      agentName: "Demo Backlog Agent",
      organizationId: "paca-default",
      projectId,
      taskId,
      fetch: fetchMock as typeof fetch,
      now: () => new Date("2026-08-31T00:00:00.000Z"),
    });

    expect(registration.config.privateKey.d).toEqual(expect.any(String));
    expect(registration.config.capabilities).toContain("task.create");
    expect(registration.config.grantRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability: "task.write",
          constraints: expect.objectContaining({
            organizationId: "paca-default",
            projectId,
            taskId,
            field: "description",
            operationMode: "collaborate",
            validUntil: "2026-08-31T00:14:00.000Z",
          }),
        }),
      ]),
    );
    expect(registration.approval.userCode).toBe("ABCD-EFGH");
  });

  it("executes each action with a fresh signed Agent JWT", async () => {
    const identity = await generateAgentHostIdentity();
    const seenJti = new Set<string>();
    const config = {
      version: 1 as const,
      providerOrigin: origin,
      issuer: `${origin}/api/auth`,
      defaultLocation: `${origin}/api/auth/capability/execute`,
      hostId,
      agentId: "agent-1",
      agentName: "Demo Backlog Agent",
      keyAlgorithm: "Ed25519" as const,
      publicKey: identity.publicKey,
      privateKey: identity.privateKey,
      capabilities: ["task.read", "task.write"],
      registeredAt: "2026-08-31T00:00:00.000Z",
    };
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const jwt = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, "");
      expect(await verifyJwt(jwt, identity.publicKey)).toBe(true);
      const payload = jwtPayload(jwt);
      expect(payload).toMatchObject({ iss: hostId, sub: "agent-1" });
      expect(seenJti.has(String(payload.jti))).toBe(false);
      seenJti.add(String(payload.jti));
      return Response.json({ data: { ok: true } });
    });

    await executeAgentCapability({
      config,
      capability: "task.read",
      arguments: { projectId, taskId },
      fetch: fetchMock as typeof fetch,
    });
    await executeAgentCapability({
      config,
      capability: "task.write",
      arguments: { projectId, taskId },
      fetch: fetchMock as typeof fetch,
    });
    expect(seenJti.size).toBe(2);
  });
});
