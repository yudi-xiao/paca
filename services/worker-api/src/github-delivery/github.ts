import * as z from "zod";
import { type RepositoryDiscoveryInput, repositoryDiscoveryInputSchema } from "./discovery";
import {
  checkSchema,
  evaluateGitHubDelivery,
  GitHubDeliveryError,
  type GitHubDeliveryEvidence,
  type GitHubDeliveryPolicy,
  type GitHubDeliveryReference,
  type GitHubPull,
  githubDeliveryPolicySchema,
  githubDeliveryReferenceSchema,
  pullSchema,
  reviewSchema,
} from "./evidence";
import { githubJson } from "./github-http";

type Fetch = typeof globalThis.fetch;
/** Fixed-origin, bounded, read-only GitHub adapter. It never follows GitHub
 * payload URLs or redirects and never returns remote bodies/errors/tokens. */
export class GitHubDeliveryReader {
  constructor(
    private readonly token?: string,
    private readonly fetch_: Fetch = globalThis.fetch,
  ) {}
  private json(path: string, signal: AbortSignal): Promise<unknown> {
    return githubJson(path, this.token, signal, this.fetch_);
  }
  private async pull(path: string, signal: AbortSignal): Promise<GitHubPull> {
    const parsed = pullSchema.safeParse(await this.json(path, signal));
    if (!parsed.success) throw new GitHubDeliveryError("GITHUB_DELIVERY_UNAVAILABLE");
    return parsed.data;
  }
  private async checks(path: string, signal: AbortSignal) {
    const checks: z.infer<typeof checkSchema>[] = [];
    const schema = z.object({
      total_count: z.number().int().nonnegative().max(500),
      check_runs: z.array(checkSchema).max(100),
    });
    let expected: number | null = null;
    for (let page = 1; page <= 5; page++) {
      const parsed = schema.safeParse(
        await this.json(`${path}?filter=all&per_page=100&page=${page}`, signal),
      );
      if (!parsed.success) throw new GitHubDeliveryError("GITHUB_DELIVERY_UNAVAILABLE");
      if (expected !== null && expected !== parsed.data.total_count)
        throw new GitHubDeliveryError("GITHUB_DELIVERY_UNAVAILABLE");
      expected = parsed.data.total_count;
      checks.push(...parsed.data.check_runs);
      if (checks.length === expected && new Set(checks.map((check) => check.id)).size === expected)
        return checks;
      if (parsed.data.check_runs.length < 100 || checks.length > expected) break;
    }
    throw new GitHubDeliveryError("GITHUB_DELIVERY_UNAVAILABLE");
  }
  private async reviews(path: string, signal: AbortSignal) {
    const reviews: z.infer<typeof reviewSchema>[] = [];
    for (let page = 1; page <= 5; page++) {
      const parsed = z
        .array(reviewSchema)
        .max(100)
        .safeParse(await this.json(`${path}?per_page=100&page=${page}`, signal));
      if (!parsed.success) throw new GitHubDeliveryError("GITHUB_DELIVERY_UNAVAILABLE");
      reviews.push(...parsed.data);
      if (
        parsed.data.length < 100 &&
        new Set(reviews.map((review) => review.id)).size === reviews.length
      )
        return reviews;
    }
    // Never treat truncated review pagination as complete evidence.
    throw new GitHubDeliveryError("GITHUB_DELIVERY_UNAVAILABLE");
  }
  async discoverChecks(input: RepositoryDiscoveryInput, signal: AbortSignal) {
    if (!repositoryDiscoveryInputSchema.safeParse(input).success)
      throw new GitHubDeliveryError("GITHUB_DELIVERY_INPUT_INVALID");
    const repo = `/repos/${input.owner}/${input.repository}`;
    const path = `${repo}/pulls/${input.pullNumber}`;
    const initial = await this.pull(path, signal);
    if (
      initial.number !== input.pullNumber ||
      initial.base.repo.full_name.toLowerCase() !==
        `${input.owner}/${input.repository}`.toLowerCase()
    )
      throw new GitHubDeliveryError("GITHUB_DELIVERY_UNAVAILABLE");
    const checks = await this.checks(`${repo}/commits/${initial.head.sha}/check-runs`, signal);
    const current = await this.pull(path, signal);
    if (
      current.number !== input.pullNumber ||
      current.base.repo.full_name.toLowerCase() !==
        `${input.owner}/${input.repository}`.toLowerCase() ||
      current.head.sha !== initial.head.sha
    )
      throw new GitHubDeliveryError("GITHUB_DELIVERY_UNAVAILABLE");
    const latest = new Map<string, z.infer<typeof checkSchema>>();
    for (const check of checks) {
      if (check.head_sha !== initial.head.sha)
        throw new GitHubDeliveryError("GITHUB_DELIVERY_UNAVAILABLE");
      const key = `${check.app.id}:${check.name}`;
      if ((latest.get(key)?.id ?? 0) < check.id) latest.set(key, check);
    }
    return {
      headSha: initial.head.sha,
      observedAt: new Date().toISOString(),
      checks: [...latest.values()]
        .sort((a, b) => a.name.localeCompare(b.name) || a.app.id - b.app.id)
        .map((check) => ({
          name: check.name,
          appId: check.app.id,
          appName: check.app.name ?? null,
          appSlug: check.app.slug ?? null,
        })),
    };
  }
  async inspect(
    value: GitHubDeliveryPolicy,
    referenceValue: GitHubDeliveryReference,
    signal = AbortSignal.timeout(20000),
  ): Promise<GitHubDeliveryEvidence> {
    const policy = githubDeliveryPolicySchema.safeParse(value);
    const reference = githubDeliveryReferenceSchema.safeParse(referenceValue);
    if (!policy.success || !reference.success)
      throw new GitHubDeliveryError("GITHUB_DELIVERY_INPUT_INVALID");
    const repo = `/repos/${policy.data.owner}/${policy.data.repository}`;
    const path = `${repo}/pulls/${reference.data.pullNumber}`;
    const initial = await this.pull(path, signal);
    // Avoid fetching checks or review content from a mismatched PR/head.
    if (
      initial.base.repo.full_name.toLowerCase() !==
        `${policy.data.owner}/${policy.data.repository}`.toLowerCase() ||
      initial.number !== reference.data.pullNumber ||
      initial.head.sha !== reference.data.headSha
    )
      return evaluateGitHubDelivery(policy.data, reference.data, {
        pull: initial,
        checks: [],
        reviews: [],
        complete: true,
        observedAt: new Date(),
      });
    const results = await Promise.allSettled([
      this.checks(`${repo}/commits/${reference.data.headSha}/check-runs`, signal),
      this.reviews(`${path}/reviews`, signal),
    ]);
    const checks = results[0];
    const reviews = results[1];
    if (checks.status !== "fulfilled" || reviews.status !== "fulfilled")
      throw new GitHubDeliveryError("GITHUB_DELIVERY_UNAVAILABLE");
    // Re-read the head after collecting evidence. A push during collection
    // invalidates the result; no old commit's green CI is reused.
    const current = await this.pull(path, signal);
    return evaluateGitHubDelivery(policy.data, reference.data, {
      pull: current,
      checks: checks.value,
      reviews: reviews.value,
      complete: true,
      observedAt: new Date(),
    });
  }
}
