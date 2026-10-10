import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GitHubAppDeliverySource, githubAppJwt } from "../src/github-delivery/github-app";
import type { RepositoryBinding, RepositoryBindingInput } from "../src/github-delivery/service";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const credentials = {
  appId: "99",
  privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
};
const input: RepositoryBindingInput = {
  requestId: crypto.randomUUID(),
  expectedVersion: 0,
  repositoryId: 100,
  installationId: 200,
  policy: {
    owner: "paca-test",
    repository: "delivery",
    requiredChecks: [{ name: "Tests", appId: 123 }],
    maxCheckAgeSeconds: 86400,
    reviewerIds: [],
    requiredApprovals: 0,
  },
};
function token() {
  return {
    token: "temporary-installation-token",
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    permissions: { metadata: "read", checks: "read", pull_requests: "read" },
    repositories: [{ id: 100, full_name: "paca-test/delivery" }],
  };
}
function repo() {
  return { id: 100, full_name: "paca-test/delivery", archived: false, disabled: false };
}
describe("GitHub App delivery credentials", () => {
  it("signs a bounded RS256 App JWT without exposing a private key", () => {
    const now = new Date("2026-10-10T00:00:00Z");
    const jwt = githubAppJwt(credentials, now);
    const [header, payload, signature] = jwt.split(".");
    if (!header || !payload || !signature) throw Error("JWT_INVALID");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({
      iss: "99",
      iat: Math.floor(now.getTime() / 1000) - 60,
      exp: Math.floor(now.getTime() / 1000) + 540,
    });
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
  });
  it.each([
    { appId: "99" },
    { appId: "invalid", privateKey: credentials.privateKey },
    { ...credentials, privateKey: "broken" },
  ])("fails closed when App credentials are unavailable", async (config) => {
    const fetch_ = vi.fn<typeof fetch>();
    await expect(
      new GitHubAppDeliverySource(config, fetch_).verifyRepository(input),
    ).rejects.toMatchObject({ code: "GITHUB_DELIVERY_APP_NOT_CONFIGURED" });
    expect(fetch_).not.toHaveBeenCalled();
  });
  it("mints exactly one repository's read-only token and checks its immutable ID and canonical name", async () => {
    const fetch_ = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(token()))
      .mockResolvedValueOnce(Response.json(repo()));
    await new GitHubAppDeliverySource(credentials, fetch_).verifyRepository(input);
    expect(fetch_).toHaveBeenCalledTimes(2);
    expect(fetch_.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/app/installations/200/access_tokens",
    );
    const options = fetch_.mock.calls[0]?.[1];
    expect(options?.method).toBe("POST");
    expect(options?.redirect).toBe("error");
    expect(JSON.parse(String(options?.body))).toEqual({
      repository_ids: [100],
      permissions: { metadata: "read", checks: "read", pull_requests: "read" },
    });
    expect(new Headers(fetch_.mock.calls[1]?.[1]?.headers).get("authorization")).toBe(
      "Bearer temporary-installation-token",
    );
  });
  it.each([
    { repositories: [{ id: 101, full_name: "paca-test/delivery" }] },
    { repositories: [{ id: 100, full_name: "foreign/repository" }] },
    {
      repositories: [
        { id: 100, full_name: "paca-test/delivery" },
        { id: 101, full_name: "foreign/repository" },
      ],
    },
    { permissions: { metadata: "read", checks: "write", pull_requests: "read" } },
    { permissions: { metadata: "read", checks: "read", pull_requests: "read", contents: "read" } },
    { expires_at: new Date(0).toISOString() },
    { expires_at: new Date(Date.now() + 7200000).toISOString() },
  ])("rejects unexpected token scope, permission or expiry: %j", async (extra) => {
    const fetch_ = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...token(), ...extra }));
    await expect(
      new GitHubAppDeliverySource(credentials, fetch_).verifyRepository(input),
    ).rejects.toMatchObject({ code: "GITHUB_DELIVERY_UNAVAILABLE" });
    expect(fetch_).toHaveBeenCalledTimes(1);
  });
  it.each([
    { id: 101 },
    { full_name: "foreign/repository" },
    { archived: true },
    { disabled: true },
  ])("rejects a different or inactive GitHub repository", async (extra) => {
    const fetch_ = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(token()))
      .mockResolvedValueOnce(Response.json({ ...repo(), ...extra }));
    await expect(
      new GitHubAppDeliverySource(credentials, fetch_).verifyRepository(input),
    ).rejects.toMatchObject({ code: "GITHUB_DELIVERY_UNAVAILABLE" });
  });
  it("collects fixed-commit evidence with the short-lived token and returns no credential", async () => {
    const headSha = "a".repeat(40);
    const fetch_ = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.includes("/access_tokens")) return Response.json(token());
      if (path === "/repos/paca-test/delivery") return Response.json(repo());
      if (path.endsWith("/reviews")) return Response.json([]);
      if (path.endsWith("/check-runs"))
        return Response.json({
          total_count: 1,
          check_runs: [
            {
              id: 1,
              name: "Tests",
              app: { id: 123 },
              status: "completed",
              conclusion: "success",
              head_sha: headSha,
              completed_at: new Date().toISOString(),
            },
          ],
        });
      if (path.endsWith("/pulls/42"))
        return Response.json({
          number: 42,
          state: "open",
          draft: false,
          merged: false,
          user: { id: 1 },
          head: { sha: headSha },
          base: { repo: { full_name: "paca-test/delivery" } },
        });
      throw Error("UNEXPECTED_REQUEST");
    });
    const binding: RepositoryBinding = {
      ...input,
      projectId: crypto.randomUUID(),
      version: 1,
      status: "active",
      updatedAt: new Date(),
    };
    const report = await new GitHubAppDeliverySource(credentials, fetch_).inspect(binding, {
      pullNumber: 42,
      headSha,
    });
    expect(report.state).toBe("awaiting_acceptance");
    expect(JSON.stringify(report)).not.toContain("temporary-installation-token");
    expect(
      fetch_.mock.calls.filter(([url]) => String(url).includes("/access_tokens")),
    ).toHaveLength(1);
  });
});
