import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { AppBindings } from "../src/bindings";
import { verifyGitHubWebhook } from "../src/github-delivery/webhook";

const secret = "test-only-secret-with-at-least-20-characters";
function request(event: string, value: unknown, changes: Record<string, string> = {}) {
  const body = JSON.stringify(value);
  return new Request("https://paca.test/api/integrations/github/webhook", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-github-delivery": crypto.randomUUID(),
      "x-github-event": event,
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      ...changes,
    },
  });
}
describe("GitHub webhook verification", () => {
  it("extracts only routing metadata from authenticated UTF-8 raw bytes", async () => {
    const event = await verifyGitHubWebhook(
      request("pull_request", {
        installation: { id: 200 },
        repository: { id: 100 },
        action: "synchronize",
        pull_request: { number: 42, head: { sha: "a".repeat(40) }, body: "私有正文不能保存" },
      }),
      secret,
    );
    expect(event).toMatchObject({
      installationId: 200,
      repositoryId: 100,
      pullNumber: 42,
      headSha: null,
      revoke: false,
    });
    expect(JSON.stringify(event)).not.toContain("私有正文");
    expect(event?.digest).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each(["check_run", "check_suite"])("binds %s invalidation to the commit", async (event) => {
    expect(
      await verifyGitHubWebhook(
        request(event, {
          installation: { id: 200 },
          repository: { id: 100 },
          [event]: { head_sha: "b".repeat(40) },
        }),
        secret,
      ),
    ).toMatchObject({ headSha: "b".repeat(40), pullNumber: null });
  });
  it("supports installation removal and never auto-reactivates on addition", async () => {
    expect(
      await verifyGitHubWebhook(
        request("installation", { installation: { id: 200 }, action: "suspend" }),
        secret,
      ),
    ).toMatchObject({ revoke: true, repositoryId: null });
    expect(
      await verifyGitHubWebhook(
        request("installation_repositories", {
          installation: { id: 200 },
          action: "removed",
          repositories_removed: [{ id: 100 }],
        }),
        secret,
      ),
    ).toMatchObject({ revoke: true, removedRepositoryIds: [100] });
    expect(
      await verifyGitHubWebhook(
        request("installation", { installation: { id: 200 }, action: "unsuspend" }),
        secret,
      ),
    ).toBeNull();
  });
  it("accepts an authenticated initial ping without an installation", async () => {
    const app = createApp({ log: vi.fn() });
    const response = await app.fetch(request("ping", { zen: "test", hook_id: 1 }), {
      GITHUB_WEBHOOK_SECRET: secret,
    } as AppBindings);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ignored" });
  });
  it.each([
    {},
    { "x-hub-signature-256": "sha256=bad" },
    { "x-hub-signature-256": `sha256=${"0".repeat(64)}` },
  ])("rejects malformed or mismatched signatures", async (headers) => {
    const valid = request(
      "ping",
      {},
      Object.fromEntries(
        Object.entries(headers).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    );
    if (!Object.keys(headers).length) valid.headers.delete("x-hub-signature-256");
    await expect(verifyGitHubWebhook(valid, secret)).rejects.toMatchObject({
      code: "GITHUB_WEBHOOK_SIGNATURE_INVALID",
    });
  });
  it("rejects unconfigured secrets, invalid IDs and excessive streamed bodies", async () => {
    await expect(verifyGitHubWebhook(request("ping", {}), undefined)).rejects.toMatchObject({
      code: "GITHUB_WEBHOOK_NOT_CONFIGURED",
    });
    await expect(
      verifyGitHubWebhook(request("ping", {}, { "x-github-delivery": "bad" }), secret),
    ).rejects.toMatchObject({ code: "GITHUB_WEBHOOK_INPUT_INVALID" });
    await expect(
      verifyGitHubWebhook(request("ping", { body: "x".repeat(1024 * 1024) }), secret),
    ).rejects.toMatchObject({ code: "GITHUB_WEBHOOK_TOO_LARGE" });
  });
});
