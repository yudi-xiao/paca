import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GitHubAppDeliverySource, githubAppJwt } from "../../src/github-delivery/github-app";
import { githubJson } from "../../src/github-delivery/github-http";
import { verifyGitHubWebhook } from "../../src/github-delivery/webhook";

describe("GitHub App credentials in the Workers runtime", () => {
  it("preserves 64-bit GitHub webhook delivery IDs without rounding in Workers", async () => {
    expect(
      await githubJson(
        "/app/hook/deliveries",
        undefined,
        AbortSignal.timeout(20000),
        async () => new Response('[{"id":3847469984089382912}]'),
      ),
    ).toEqual([{ id: "3847469984089382912" }]);
  });
  it("verifies signed UTF-8 webhook bytes with Workers Web Crypto", async () => {
    const secret = "worker-test-secret-at-least-20-characters";
    const body = JSON.stringify({ zen: "中文", hook_id: 1 });
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = Array.from(
      new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const request = new Request("https://paca.test/api/integrations/github/webhook", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": crypto.randomUUID(),
        "x-github-event": "ping",
        "x-hub-signature-256": `sha256=${signature}`,
      },
    });
    expect(await verifyGitHubWebhook(request, secret)).toBeNull();
  });
  it("signs and verifies an RSA App JWT using a GitHub-style PKCS1 PEM", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwt = githubAppJwt({
      appId: "99",
      privateKey: privateKey.export({ format: "pem", type: "pkcs1" }).toString(),
    });
    const [header, payload, signature] = jwt.split(".");
    if (!header || !payload || !signature) throw Error("JWT_INVALID");
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
    expect(JSON.parse(Buffer.from(payload, "base64url").toString()).iss).toBe("99");
  });
  it("mints only a one-repository read-only token and rejects a broader response", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const source = new GitHubAppDeliverySource(
      { appId: "99", privateKey: privateKey.export({ format: "pem", type: "pkcs1" }).toString() },
      async (_request, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          repository_ids: [100],
          permissions: { checks: "read", pull_requests: "read", metadata: "read" },
        });
        return Response.json({
          token: "test-token",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
          permissions: { checks: "write", pull_requests: "read", metadata: "read" },
          repositories: [{ id: 100, full_name: "test/repo" }],
        });
      },
    );
    await expect(
      source.verifyRepository({
        requestId: crypto.randomUUID(),
        expectedVersion: 0,
        installationId: 200,
        repositoryId: 100,
        policy: {
          owner: "test",
          repository: "repo",
          requiredChecks: [{ name: "Tests", appId: 123 }],
          maxCheckAgeSeconds: 86400,
          reviewerIds: [],
          requiredApprovals: 0,
        },
      }),
    ).rejects.toMatchObject({ code: "GITHUB_DELIVERY_UNAVAILABLE" });
  });
});
