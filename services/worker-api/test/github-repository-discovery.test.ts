import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  GitHubRepositoryDiscoveryService,
  type RepositoryDiscovery,
} from "../src/github-delivery/discovery";
import { GitHubAppDeliverySource } from "../src/github-delivery/github-app";
import { DeliveryWorkflowError } from "../src/github-delivery/service";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const credentials = {
  appId: "99",
  privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
};
const input = {
  owner: "paca-test",
  repository: "delivery",
  pullNumber: 42,
  reviewerLogins: ["alice"],
};
const sha = "a".repeat(40);
const permissions = { metadata: "read", checks: "read", pull_requests: "read" };
function fixture() {
  const installation = {
    id: 200,
    app_id: 99,
    account: { login: "paca-test" },
    suspended_at: null,
    permissions,
  };
  const minted = {
    token: "installation-token",
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    permissions,
    repositories: [{ id: 100, full_name: "paca-test/delivery" }],
  };
  const pull = {
    number: 42,
    state: "open",
    draft: true,
    merged: false,
    user: { id: 1 },
    head: { sha },
    base: { repo: { full_name: "paca-test/delivery" } },
  };
  const check = {
    id: 10,
    name: "Tests",
    head_sha: sha,
    status: "completed",
    conclusion: "success",
    completed_at: new Date().toISOString(),
    app: { id: 123, name: "Trusted CI", slug: "trusted-ci" },
    details_url: "https://untrusted.example/never-follow",
  };
  const checks = {
    total_count: 3,
    check_runs: [
      check,
      { ...check, id: 11 },
      { ...check, id: 12, app: { id: 124, name: "Other CI", slug: "other-ci" } },
    ],
  };
  const user = {
    id: 2,
    login: "alice",
    type: "User",
    email: "never-return@example.test",
    bio: "private-unrelated-content",
  };
  let pullReads = 0;
  let changed = false;
  const fetch_ = vi.fn<typeof fetch>(async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/installation")) return Response.json(installation);
    if (path.endsWith("/access_tokens")) return Response.json(minted);
    if (path === "/repos/paca-test/delivery")
      return Response.json({
        id: 100,
        full_name: "paca-test/delivery",
        archived: false,
        disabled: false,
      });
    if (path.endsWith("/pulls/42")) {
      pullReads++;
      return Response.json(
        changed && pullReads > 1 ? { ...pull, head: { sha: "b".repeat(40) } } : pull,
      );
    }
    if (path.endsWith("/check-runs")) return Response.json(checks);
    if (path === "/users/alice" || path === "/user/2") return Response.json(user);
    throw Error(`UNEXPECTED_TEST_PATH:${path}:${options?.method}`);
  });
  return {
    installation,
    minted,
    pull,
    checks,
    user,
    fetch_,
    source: new GitHubAppDeliverySource(credentials, fetch_),
    changeHead: () => {
      changed = true;
    },
  };
}
describe("GitHub repository configuration discovery", () => {
  it("narrows by one repository, pins each publisher and reduces reviewer identity without exposing credentials", async () => {
    const f = fixture();
    const result = await f.source.discover(input);
    expect(result).toMatchObject({
      repositoryId: 100,
      installationId: 200,
      headSha: sha,
      pullNumber: 42,
      checks: [
        { name: "Tests", appId: 123, appName: "Trusted CI", appSlug: "trusted-ci" },
        { name: "Tests", appId: 124, appName: "Other CI", appSlug: "other-ci" },
      ],
      reviewers: [{ id: 2, login: "alice" }],
    });
    const mint = f.fetch_.mock.calls.find(([url]) => String(url).endsWith("access_tokens"));
    expect(JSON.parse(String(mint?.[1]?.body))).toEqual({
      repositories: ["delivery"],
      permissions,
    });
    const publicUser = f.fetch_.mock.calls.find(([url]) => String(url).endsWith("/users/alice"));
    expect(new Headers(publicUser?.[1]?.headers).get("authorization")).toBe(
      "Bearer installation-token",
    );
    expect(
      f.fetch_.mock.calls.every(
        ([url, options]) =>
          String(url).startsWith("https://api.github.com/") && options?.redirect === "error",
      ),
    ).toBe(true);
    expect(new Set(f.fetch_.mock.calls.map(([, options]) => options?.signal)).size).toBe(1);
    expect(JSON.stringify(result)).not.toMatch(
      /installation-token|PRIVATE KEY|never-return|private-unrelated|untrusted.example/,
    );
  });
  it("resolves persisted reviewer IDs to current canonical names", async () => {
    const f = fixture();
    expect(
      (await f.source.discover({ ...input, reviewerLogins: undefined, reviewerIds: [2] }))
        .reviewers,
    ).toEqual([{ id: 2, login: "alice" }]);
    expect(f.fetch_.mock.calls.some(([url]) => String(url).endsWith("/user/2"))).toBe(true);
  });
  it.each([
    { owner: "https://untrusted.example" },
    { repository: "../foreign" },
    { pullNumber: 0 },
    { reviewerLogins: ["alice", "ALICE"] },
    { reviewerIds: [2, 2], reviewerLogins: undefined },
    { reviewerIds: [2] },
    { reviewerLogins: Array.from({ length: 21 }, (_, i) => `reviewer-${i}`) },
    { token: "forged" },
  ])("rejects invalid or excessive discovery before I/O: %j", async (extra) => {
    const f = fixture();
    await expect(f.source.discover({ ...input, ...extra })).rejects.toMatchObject({
      code: "GITHUB_DELIVERY_INPUT_INVALID",
    });
    expect(f.fetch_).not.toHaveBeenCalled();
  });
  it.each([
    "app",
    "owner",
    "suspended",
    "permissions",
    "token-scope",
    "token-name",
    "expiry",
    "reviewer-bot",
    "reviewer-name",
    "checks-incomplete",
    "head-changed",
  ])("fails closed for %s", async (mode) => {
    const f = fixture();
    if (mode === "app") f.installation.app_id = 98;
    if (mode === "owner") f.installation.account.login = "foreign";
    if (mode === "suspended")
      Object.assign(f.installation, { suspended_at: new Date().toISOString() });
    if (mode === "permissions") Object.assign(f.installation.permissions, { contents: "read" });
    if (mode === "token-scope")
      f.minted.repositories.push({ id: 101, full_name: "paca-test/other" });
    if (mode === "token-name") f.minted.repositories = [{ id: 100, full_name: "foreign/delivery" }];
    if (mode === "expiry") f.minted.expires_at = new Date(0).toISOString();
    if (mode === "reviewer-bot") f.user.type = "Bot";
    if (mode === "reviewer-name") f.user.login = "foreign";
    if (mode === "checks-incomplete") f.checks.total_count = 4;
    if (mode === "head-changed") f.changeHead();
    await expect(f.source.discover(input)).rejects.toMatchObject({
      code: "GITHUB_DELIVERY_UNAVAILABLE",
    });
  });
  it("rechecks current project and system authority after external reads", async () => {
    const output: RepositoryDiscovery = {
      ...input,
      repositoryId: 100,
      installationId: 200,
      headSha: sha,
      observedAt: new Date().toISOString(),
      checks: [],
      reviewers: [],
    };
    const source = { discover: vi.fn(async () => output) };
    const authorize = vi
      .fn(async () => {})
      .mockRejectedValueOnce(new DeliveryWorkflowError("DELIVERY_PERMISSION_DENIED"));
    const service = new GitHubRepositoryDiscoveryService(source, authorize);
    const projectId = crypto.randomUUID();
    await expect(service.discover(projectId, "user", input)).rejects.toMatchObject({
      code: "DELIVERY_PERMISSION_DENIED",
    });
    expect(source.discover).not.toHaveBeenCalled();
    authorize
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new DeliveryWorkflowError("DELIVERY_PERMISSION_DENIED"));
    await expect(service.discover(projectId, "user", input)).rejects.toMatchObject({
      code: "DELIVERY_PERMISSION_DENIED",
    });
    expect(source.discover).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenLastCalledWith(projectId, "user", true);
  });
  it("rejects a forged source result instead of returning another repository", async () => {
    const source = {
      discover: vi.fn(async () => ({
        owner: "foreign",
        repository: "delivery",
        repositoryId: 100,
        installationId: 200,
        pullNumber: 42,
        headSha: sha,
        observedAt: new Date().toISOString(),
        checks: [],
        reviewers: [],
      })),
    };
    await expect(
      new GitHubRepositoryDiscoveryService(source, async () => {}).discover(
        crypto.randomUUID(),
        "user",
        input,
      ),
    ).rejects.toMatchObject({ code: "DELIVERY_SCOPE_MISMATCH" });
  });
  it("returns only the requested reviewer identities after both authority checks", async () => {
    const output: RepositoryDiscovery = {
      owner: input.owner,
      repository: input.repository,
      pullNumber: input.pullNumber,
      repositoryId: 100,
      installationId: 200,
      headSha: sha,
      observedAt: new Date().toISOString(),
      checks: [],
      reviewers: [{ id: 2, login: "alice" }],
    };
    const source = { discover: vi.fn(async () => output) };
    const authorize = vi.fn(async () => {});
    const service = new GitHubRepositoryDiscoveryService(source, authorize);
    expect(await service.discover(crypto.randomUUID(), "user", input)).toEqual(output);
    expect(authorize).toHaveBeenCalledTimes(2);
    await expect(
      service.discover(crypto.randomUUID(), "user", {
        ...input,
        reviewerLogins: undefined,
        reviewerIds: [3],
      }),
    ).rejects.toMatchObject({ code: "DELIVERY_SCOPE_MISMATCH" });
  });
});
