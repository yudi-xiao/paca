import { describe, expect, it, vi } from "vitest";
import {
  evaluateGitHubDelivery,
  type GitHubDeliveryPolicy,
  type GitHubDeliverySnapshot,
  githubDeliveryPolicySchema,
} from "../src/github-delivery/evidence";
import { GitHubDeliveryReader } from "../src/github-delivery/github";

const sha = "a".repeat(40);
const other = "b".repeat(40);
const now = new Date("2026-10-10T00:00:00Z");
const policy: GitHubDeliveryPolicy = {
  owner: "paca-test",
  repository: "delivery",
  requiredChecks: [{ name: "Release tests", appId: 123 }],
  maxCheckAgeSeconds: 86400,
  requiredApprovals: 1,
  reviewerIds: [2],
};
const reference = { pullNumber: 42, headSha: sha };
function snapshot(): GitHubDeliverySnapshot {
  return {
    pull: {
      number: 42,
      state: "open",
      draft: false,
      merged: false,
      user: { id: 1 },
      head: { sha },
      base: { repo: { full_name: "paca-test/delivery" } },
    },
    checks: [
      {
        id: 10,
        name: "Release tests",
        head_sha: sha,
        status: "completed",
        conclusion: "success",
        completed_at: now.toISOString(),
        app: { id: 123 },
      },
    ],
    reviews: [
      {
        id: 20,
        user: { id: 2 },
        state: "APPROVED",
        commit_id: sha,
        submitted_at: now.toISOString(),
      },
    ],
    complete: true,
    observedAt: now,
  };
}
describe("GitHub fixed-commit delivery evidence", () => {
  it("requires human acceptance after trusted CI and current-commit review", () => {
    const report = evaluateGitHubDelivery(policy, reference, snapshot(), now);
    expect(report).toMatchObject({
      state: "awaiting_acceptance",
      headSha: sha,
      approvalCount: 1,
      reasons: [],
    });
    expect(report).not.toHaveProperty("acceptedBy");
  });
  it.each([
    "failure",
    "cancelled",
    "timed_out",
    "neutral",
    "skipped",
    "action_required",
    "unknown",
  ])("does not treat %s as success", (conclusion) => {
    const value = snapshot();
    const check = value.checks[0];
    if (!check) throw Error();
    check.conclusion = conclusion;
    expect(evaluateGitHubDelivery(policy, reference, value, now).state).toBe("needs_changes");
  });
  it("rejects same-name checks from a different App or commit", () => {
    for (const field of ["app", "sha"]) {
      const value = snapshot();
      const check = value.checks[0];
      if (!check) throw Error();
      if (field === "app") check.app.id = 999;
      else check.head_sha = other;
      expect(evaluateGitHubDelivery(policy, reference, value, now)).toMatchObject({
        state: "waiting",
        checks: [{ state: "missing" }],
      });
    }
  });
  it("a newer failed run overrides an older successful run", () => {
    const value = snapshot();
    const check = value.checks[0];
    if (!check) throw Error();
    value.checks.push({ ...check, id: 11, conclusion: "failure" });
    expect(evaluateGitHubDelivery(policy, reference, value, now).state).toBe("needs_changes");
  });
  it("a PR push invalidates all previous evidence", () => {
    const value = snapshot();
    value.pull.head.sha = other;
    expect(evaluateGitHubDelivery(policy, reference, value, now)).toMatchObject({
      state: "stale",
      reasons: ["PR_HEAD_CHANGED"],
    });
  });
  it.each([
    null,
    "2026-10-08T23:59:59Z",
    "2026-10-10T00:00:06Z",
  ])("requires a recent completion time even when GitHub reports success (%s)", (completedAt) => {
    const value = snapshot();
    const check = value.checks[0];
    if (!check) throw Error();
    check.completed_at = completedAt;
    expect(evaluateGitHubDelivery(policy, reference, value, now)).toMatchObject({
      checks: [{ state: "stale" }],
      reasons: expect.arrayContaining(["REQUIRED_CHECK_STALE"]),
    });
    expect(evaluateGitHubDelivery(policy, reference, value, now).state).not.toBe(
      "awaiting_acceptance",
    );
  });
  it.each([
    "foreign-repo",
    "foreign-pr",
    "incomplete",
    "stale",
    "future",
  ])("fails closed for %s evidence", (kind) => {
    const value = snapshot();
    if (kind === "foreign-repo") value.pull.base.repo.full_name = "other/delivery";
    if (kind === "foreign-pr") value.pull.number = 99;
    if (kind === "incomplete") value.complete = false;
    if (kind === "stale") value.observedAt = new Date(now.getTime() - 60001);
    if (kind === "future") value.observedAt = new Date(now.getTime() + 5001);
    expect(evaluateGitHubDelivery(policy, reference, value, now).state).toBe("unavailable");
  });
  it.each([
    "stale",
    "author",
    "untrusted",
    "dismissed",
    "changes",
  ])("rejects %s reviews", (kind) => {
    const value = snapshot();
    const review = value.reviews[0];
    if (!review) throw Error();
    if (kind === "stale") review.commit_id = other;
    if (kind === "author") value.pull.user.id = 2;
    if (kind === "untrusted") review.user = { id: 999 };
    if (kind === "dismissed") review.state = "DISMISSED";
    if (kind === "changes") review.state = "CHANGES_REQUESTED";
    expect(evaluateGitHubDelivery(policy, reference, value, now).state).not.toBe(
      "awaiting_acceptance",
    );
  });
  it("uses a reviewer's latest decision regardless of transport order", () => {
    const value = snapshot();
    value.reviews.unshift({
      id: 21,
      user: { id: 2 },
      state: "CHANGES_REQUESTED",
      commit_id: sha,
      submitted_at: new Date(now.getTime() + 1000).toISOString(),
    });
    expect(evaluateGitHubDelivery(policy, reference, value, now).state).toBe("needs_changes");
  });
  it("draft and closed unmerged PRs cannot pass", () => {
    const value = snapshot();
    value.pull.draft = true;
    expect(evaluateGitHubDelivery(policy, reference, value, now).state).toBe("waiting");
    value.pull.draft = false;
    value.pull.state = "closed";
    expect(evaluateGitHubDelivery(policy, reference, value, now).state).toBe("needs_changes");
  });
  it("requires explicit non-empty CI policy and bounded reviewers", () => {
    expect(githubDeliveryPolicySchema.safeParse({ ...policy, requiredChecks: [] }).success).toBe(
      false,
    );
    expect(githubDeliveryPolicySchema.safeParse({ ...policy, requiredApprovals: 2 }).success).toBe(
      false,
    );
    expect(
      githubDeliveryPolicySchema.safeParse({ ...policy, repository: "../escape" }).success,
    ).toBe(false);
  });
});
describe("GitHub evidence HTTP adapter", () => {
  function transport(changes?: { push?: boolean; failure?: boolean; count?: number }) {
    let pulls = 0;
    return vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      const value = snapshot();
      for (const check of value.checks) check.completed_at = new Date().toISOString();
      if (url.pathname.endsWith("/check-runs"))
        return Response.json({ total_count: changes?.count ?? 1, check_runs: value.checks });
      if (url.pathname.endsWith("/reviews")) return Response.json(value.reviews);
      pulls++;
      if (changes?.failure)
        return Response.json({ private: "token and repository body" }, { status: 403 });
      return Response.json({
        ...value.pull,
        head: { sha: changes?.push && pulls > 1 ? other : sha },
        body: "Private PR text must not leave adapter",
      });
    });
  }
  it("reads fixed-origin endpoints, authenticates only GitHub, strips payloads and rechecks the head", async () => {
    const fetch_ = transport();
    const report = await new GitHubDeliveryReader("private-token", fetch_).inspect(
      policy,
      reference,
    );
    expect(report.state).toBe("awaiting_acceptance");
    expect(JSON.stringify(report)).not.toContain("Private PR text");
    expect(JSON.stringify(report)).not.toContain("private-token");
    expect(fetch_).toHaveBeenCalledTimes(4);
    for (const [url, init] of fetch_.mock.calls) {
      expect(new URL(String(url)).origin).toBe("https://api.github.com");
      expect(init).toMatchObject({
        method: "GET",
        redirect: "error",
        signal: expect.any(AbortSignal),
        headers: { authorization: "Bearer private-token", "x-github-api-version": "2026-03-10" },
      });
    }
  });
  it("detects a push that happens during collection", async () => {
    expect(
      (
        await new GitHubDeliveryReader(undefined, transport({ push: true })).inspect(
          policy,
          reference,
        )
      ).state,
    ).toBe("stale");
  });
  it.each([
    { failure: true },
    { count: 501 },
    { count: 2 },
  ])("rejects remote failure and incomplete/oversized pagination %j", async (changes) => {
    await expect(
      new GitHubDeliveryReader(undefined, transport(changes)).inspect(policy, reference),
    ).rejects.toThrow("GITHUB_DELIVERY_UNAVAILABLE");
  });
  it("rejects invalid input before fetching", async () => {
    const fetch_ = transport();
    await expect(
      new GitHubDeliveryReader(undefined, fetch_).inspect(policy, {
        pullNumber: 42,
        headSha: "branch-name",
      }),
    ).rejects.toThrow("GITHUB_DELIVERY_INPUT_INVALID");
    expect(fetch_).not.toHaveBeenCalled();
  });
  it("bounds streamed GitHub responses without trusting Content-Length", async () => {
    const cancel = vi.fn();
    const fetch_ = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(1024 * 1024 + 1));
            },
            cancel,
          }),
          { headers: { "content-length": "1" } },
        ),
    );
    await expect(
      new GitHubDeliveryReader(undefined, fetch_).inspect(policy, reference),
    ).rejects.toThrow("GITHUB_DELIVERY_TOO_LARGE");
    expect(cancel).toHaveBeenCalled();
  });
});
