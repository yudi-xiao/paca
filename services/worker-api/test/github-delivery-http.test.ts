import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { AppBindings } from "../src/bindings";
import { GitHubDeliveryError } from "../src/github-delivery/evidence";
import type { GitHubDeliveryRuntime } from "../src/github-delivery/runtime";
import {
  DeliveryWorkflowError,
  type RepositoryBinding,
  type TaskDelivery,
} from "../src/github-delivery/service";
import type { AuthorizeProjectPermission, AuthorizeSystemPermission } from "../src/permission/http";

const projectId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const leaseId = "33333333-3333-4333-8333-333333333333";
const env = { ENVIRONMENT: "internal", TRUSTED_ORIGINS: "https://paca.example" } as AppBindings;
const allow: AuthorizeProjectPermission = async () => ({
  authenticated: true,
  userId: "trusted-user",
  decision: { allowed: true, scopeExists: true, grants: [] },
});
const system: AuthorizeSystemPermission = async () => ({
  authenticated: true,
  userId: "trusted-user",
  allowed: true,
  grants: [],
});
function runtime() {
  const binding: RepositoryBinding = {
    projectId,
    repositoryId: 100,
    installationId: 200,
    version: 1,
    status: "active",
    updatedAt: new Date(),
    policy: {
      owner: "paca-test",
      repository: "delivery",
      requiredChecks: [{ name: "Tests", appId: 123 }],
      maxCheckAgeSeconds: 86400,
      reviewerIds: [],
      requiredApprovals: 0,
    },
  };
  const delivery: TaskDelivery = {
    id: crypto.randomUUID(),
    projectId,
    taskId,
    leaseId,
    repositoryId: 100,
    policyVersion: 1,
    version: 1,
    reference: { pullNumber: 42, headSha: "a".repeat(40) },
    state: "awaiting_acceptance",
    acceptedBy: null,
    acceptedAt: null,
    requestedChangesBy: null,
    requestedChangesAt: null,
    reviewNote: "",
    updatedAt: new Date(),
    evidence: {
      repository: "paca-test/delivery",
      pullNumber: 42,
      headSha: "a".repeat(40),
      pullUrl: "https://github.com/paca-test/delivery/pull/42",
      observedAt: new Date().toISOString(),
      state: "awaiting_acceptance",
      reasons: [],
      checks: [],
      approvalCount: 0,
    },
  };
  const implementation = {
    completedRuns: vi.fn(async () => ({
      items: [{ leaseId, harnessKind: "codex", finishedAt: new Date() }],
      nextCursor: null,
    })),
    binding: vi.fn(async () => binding),
    delivery: vi.fn(async () => delivery),
    configure: vi.fn(async () => binding),
    submit: vi.fn(async () => delivery),
    refresh: vi.fn(async () => delivery),
    decide: vi.fn(async () => delivery),
  } satisfies GitHubDeliveryRuntime;
  const app = createApp({
    githubDelivery: implementation,
    authorizeProjectPermission: allow,
    authorizeSystemPermission: system,
    log: vi.fn(),
  });
  return { implementation, app, binding, delivery };
}
const repoPath = `/api/v1/projects/${projectId}/github-repository`;
const taskPath = `/api/v1/projects/${projectId}/tasks/${taskId}/delivery`;
function request(body: unknown, method = "POST") {
  return {
    method,
    headers: { "content-type": "application/json", origin: "https://paca.example" },
    body: JSON.stringify(body),
  };
}
describe("GitHub delivery user HTTP boundary", () => {
  it("lists completed runs only through task read authorization and validates the cursor", async () => {
    const { app, implementation } = runtime();
    const response = await app.request(`${taskPath}/completed-runs`, {}, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      data: { items: [{ leaseId, harnessKind: "codex" }], nextCursor: null },
    });
    expect(implementation.completedRuns).toHaveBeenCalledWith(env, projectId, taskId, undefined);
    for (const suffix of ["?cursor=bad", `?cursor=${leaseId}&cursor=${leaseId}`])
      expect((await app.request(`${taskPath}/completed-runs${suffix}`, {}, env)).status).toBe(400);
    const denied = createApp({
      githubDelivery: implementation,
      authorizeProjectPermission: async () => ({ authenticated: false }),
      log: vi.fn(),
    });
    expect((await denied.request(`${taskPath}/completed-runs`, {}, env)).status).toBe(401);
    expect(implementation.completedRuns).toHaveBeenCalledTimes(1);
  });
  it("requires authenticated project read/write and separate system approval for repository credentials", async () => {
    const { implementation, binding } = runtime();
    const authorize = vi.fn(allow);
    const systemAuthorize = vi.fn(system);
    const app = createApp({
      githubDelivery: implementation,
      authorizeProjectPermission: authorize,
      authorizeSystemPermission: systemAuthorize,
      log: vi.fn(),
    });
    const response = await app.request(
      repoPath,
      request(
        {
          requestId: crypto.randomUUID(),
          expectedVersion: 0,
          repositoryId: 100,
          installationId: 200,
          policy: binding.policy,
        },
        "PUT",
      ),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(authorize).toHaveBeenCalledWith(expect.any(Request), env, projectId, {
      projects: ["write"],
    });
    expect(systemAuthorize).toHaveBeenCalledWith(expect.any(Request), env, { settings: ["write"] });
    expect(implementation.configure).toHaveBeenCalledWith(
      env,
      expect.any(Request),
      projectId,
      "trusted-user",
      expect.any(Object),
    );
  });
  it("denies repository setup to a project writer without system settings authority", async () => {
    const { implementation, binding } = runtime();
    const app = createApp({
      githubDelivery: implementation,
      authorizeProjectPermission: allow,
      authorizeSystemPermission: async () => ({
        authenticated: true,
        userId: "trusted-user",
        grants: [],
        allowed: false,
      }),
      log: vi.fn(),
    });
    expect(
      (
        await app.request(
          repoPath,
          request(
            {
              requestId: crypto.randomUUID(),
              expectedVersion: 0,
              repositoryId: 100,
              installationId: 200,
              policy: binding.policy,
            },
            "PUT",
          ),
          env,
        )
      ).status,
    ).toBe(403);
    expect(implementation.configure).not.toHaveBeenCalled();
  });
  it.each([
    taskPath,
    `${taskPath}/decision`,
    `${taskPath}/refresh`,
  ])("does not accept an Agent JWT as a user session: %s", async (path) => {
    const { implementation } = runtime();
    const app = createApp({
      githubDelivery: implementation,
      authorizeProjectPermission: async () => ({ authenticated: false }),
      log: vi.fn(),
    });
    expect(
      (
        await app.request(
          path,
          {
            ...request({}),
            headers: {
              authorization: "Bearer agent-jwt",
              "content-type": "application/json",
              origin: "https://paca.example",
            },
          },
          env,
        )
      ).status,
    ).toBe(401);
    expect(implementation.submit).not.toHaveBeenCalled();
    expect(implementation.decide).not.toHaveBeenCalled();
  });
  it("passes only validated fixed references and the trusted user identity", async () => {
    const { app, implementation } = runtime();
    const body = {
      requestId: crypto.randomUUID(),
      expectedVersion: 0,
      leaseId,
      pullNumber: 42,
      headSha: "a".repeat(40),
    };
    expect((await app.request(taskPath, request(body), env)).status).toBe(200);
    expect(implementation.submit).toHaveBeenCalledWith(
      env,
      expect.any(Request),
      projectId,
      taskId,
      "trusted-user",
      body,
    );
    for (const extra of [
      { actorId: "forged" },
      { acceptedBy: "forged" },
      { evidence: {} },
      { repository: "foreign/repo" },
    ])
      expect((await app.request(taskPath, request({ ...body, ...extra }), env)).status).toBe(400);
    expect(implementation.submit).toHaveBeenCalledTimes(1);
  });
  it("bounds streamed bodies, rejects malformed JSON, and enforces same-origin writes", async () => {
    const { app, implementation } = runtime();
    expect((await app.request(taskPath, request({ note: "x".repeat(33000) }), env)).status).toBe(
      413,
    );
    expect((await app.request(taskPath, { ...request({}), body: "{" }, env)).status).toBe(400);
    expect(
      (
        await app.request(
          taskPath,
          {
            ...request({}),
            headers: { origin: "https://evil.example", "content-type": "application/json" },
          },
          env,
        )
      ).status,
    ).toBe(403);
    expect(implementation.submit).not.toHaveBeenCalled();
  });
  it.each([
    ["DELIVERY_VERSION_CONFLICT", 409],
    ["DELIVERY_EVIDENCE_NOT_READY", 409],
    ["DELIVERY_PERMISSION_DENIED", 403],
    ["DELIVERY_SCOPE_MISMATCH", 403],
    ["DELIVERY_NOT_FOUND", 404],
  ] as const)("returns a stable %s error", async (code, status) => {
    const { app, implementation } = runtime();
    implementation.decide.mockRejectedValueOnce(new DeliveryWorkflowError(code));
    const response = await app.request(
      `${taskPath}/decision`,
      request({ requestId: crypto.randomUUID(), expectedVersion: 1, decision: "accept" }),
      env,
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error_code: code });
  });
  it("reports missing App setup without leaking configuration or provider errors", async () => {
    const { app, implementation, binding } = runtime();
    implementation.configure.mockRejectedValueOnce(
      new GitHubDeliveryError("GITHUB_DELIVERY_APP_NOT_CONFIGURED"),
    );
    const response = await app.request(
      repoPath,
      request(
        {
          requestId: crypto.randomUUID(),
          expectedVersion: 0,
          repositoryId: 100,
          installationId: 200,
          policy: binding.policy,
        },
        "PUT",
      ),
      env,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error_code: "GITHUB_DELIVERY_APP_NOT_CONFIGURED",
    });
  });
  it("masks stale acceptance on read while retaining historical fixed-commit attribution", async () => {
    const { app, delivery } = runtime();
    delivery.state = "accepted";
    delivery.acceptedBy = "trusted-user";
    delivery.acceptedAt = new Date();
    delivery.evidence.observedAt = new Date(Date.now() - 61000).toISOString();
    const response = await app.request(taskPath, {}, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      data: {
        state: "stale",
        acceptedBy: null,
        acceptedAt: null,
        requiresRefresh: true,
        lastAcceptance: { actorId: "trusted-user" },
      },
    });
  });
});
