import { Buffer } from "node:buffer";
import { createPrivateKey, sign } from "node:crypto";
import * as z from "zod";
import {
  type GitHubRepositoryDiscoverySource,
  type RepositoryDiscovery,
  type RepositoryDiscoveryInput,
  repositoryDiscoveryInputSchema,
} from "./discovery";
import {
  GitHubDeliveryError,
  type GitHubDeliveryPolicy,
  type GitHubDeliveryReference,
  githubDeliveryPolicySchema,
} from "./evidence";
import { GitHubDeliveryReader } from "./github";
import { githubJson } from "./github-http";
import type { GitHubDeliverySource, RepositoryBinding, RepositoryBindingInput } from "./service";

const identifier = z.number().int().positive().safe();
const permissions = { metadata: "read", checks: "read", pull_requests: "read" } as const;
const tokenSchema = z.object({
  token: z
    .string()
    .min(1)
    .max(16384)
    .regex(/^[A-Za-z0-9_.-]+$/),
  expires_at: z.iso.datetime({ offset: true }),
  permissions: z
    .object({
      metadata: z.literal("read"),
      checks: z.literal("read"),
      pull_requests: z.literal("read"),
    })
    .strict(),
  repositories: z
    .array(z.object({ id: identifier, full_name: z.string().min(1).max(200) }))
    .length(1),
});
const targetSchema = z.object({
  repositoryId: identifier,
  installationId: identifier,
  policy: githubDeliveryPolicySchema,
});
type Target = z.infer<typeof targetSchema>;
export type GitHubAppCredentials = { appId?: string; privateKey?: string };
export function githubAppJwt(credentials: GitHubAppCredentials, now = new Date()): string {
  if (
    !credentials.appId ||
    !/^[1-9][0-9]{0,15}$/.test(credentials.appId) ||
    !Number.isSafeInteger(Number(credentials.appId)) ||
    !credentials.privateKey ||
    credentials.privateKey.length > 32000
  )
    throw new GitHubDeliveryError("GITHUB_DELIVERY_APP_NOT_CONFIGURED");
  try {
    const key = createPrivateKey(credentials.privateKey);
    if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
      throw Error("INVALID_KEY");
    const time = Math.floor(now.getTime() / 1000);
    const encoded = `${Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ iat: time - 60, exp: time + 540, iss: credentials.appId })).toString("base64url")}`;
    return `${encoded}.${sign("RSA-SHA256", Buffer.from(encoded), key).toString("base64url")}`;
  } catch {
    throw new GitHubDeliveryError("GITHUB_DELIVERY_APP_NOT_CONFIGURED");
  }
}
/** Mints a per-request, one-repository, read-only installation token. It is
 * never cached in a global, persisted, logged, or returned to the client. */
export class GitHubAppDeliverySource
  implements GitHubDeliverySource, GitHubRepositoryDiscoverySource
{
  constructor(
    private readonly credentials: GitHubAppCredentials,
    private readonly fetch_: typeof fetch = globalThis.fetch,
  ) {}
  private async mint(
    installationId: number,
    selector: { repository_ids: number[] } | { repositories: string[] },
    signal: AbortSignal,
  ) {
    const parsed = tokenSchema.safeParse(
      await githubJson(
        `/app/installations/${installationId}/access_tokens`,
        githubAppJwt(this.credentials),
        signal,
        this.fetch_,
        { ...selector, permissions },
      ),
    );
    if (!parsed.success) throw new GitHubDeliveryError("GITHUB_DELIVERY_UNAVAILABLE");
    const expires = Date.parse(parsed.data.expires_at);
    if (expires < Date.now() + 30000 || expires > Date.now() + 3900000)
      throw new GitHubDeliveryError("GITHUB_DELIVERY_UNAVAILABLE");
    return parsed.data;
  }
  private async token(target: Target, signal: AbortSignal): Promise<string> {
    const minted = await this.mint(
      target.installationId,
      { repository_ids: [target.repositoryId] },
      signal,
    );
    const repository = minted.repositories[0];
    if (
      !repository ||
      repository.id !== target.repositoryId ||
      repository.full_name.toLowerCase() !==
        `${target.policy.owner}/${target.policy.repository}`.toLowerCase()
    )
      throw new GitHubDeliveryError("GITHUB_DELIVERY_UNAVAILABLE");
    return minted.token;
  }
  private async verify(
    target: { repositoryId: number; policy: Pick<GitHubDeliveryPolicy, "owner" | "repository"> },
    token: string,
    signal: AbortSignal,
  ) {
    const result = z
      .object({
        id: identifier,
        full_name: z.string(),
        archived: z.boolean(),
        disabled: z.boolean(),
      })
      .safeParse(
        await githubJson(
          `/repos/${target.policy.owner}/${target.policy.repository}`,
          token,
          signal,
          this.fetch_,
        ),
      );
    if (
      !result.success ||
      result.data.id !== target.repositoryId ||
      result.data.full_name.toLowerCase() !==
        `${target.policy.owner}/${target.policy.repository}`.toLowerCase() ||
      result.data.archived ||
      result.data.disabled
    )
      throw new GitHubDeliveryError("GITHUB_DELIVERY_UNAVAILABLE");
  }
  private target(input: {
    repositoryId: number;
    installationId: number;
    policy: GitHubDeliveryPolicy;
  }): Target {
    const parsed = targetSchema.safeParse(input);
    if (!parsed.success) throw new GitHubDeliveryError("GITHUB_DELIVERY_INPUT_INVALID");
    return parsed.data;
  }
  async verifyRepository(input: RepositoryBindingInput) {
    const target = this.target(input);
    const signal = AbortSignal.timeout(20000);
    const token = await this.token(target, signal);
    await this.verify(target, token, signal);
  }
  async inspect(binding: RepositoryBinding, reference: GitHubDeliveryReference) {
    const target = this.target(binding);
    const signal = AbortSignal.timeout(20000);
    const token = await this.token(target, signal);
    await this.verify(target, token, signal);
    return new GitHubDeliveryReader(token, this.fetch_).inspect(target.policy, reference, signal);
  }
  async discover(value: RepositoryDiscoveryInput): Promise<RepositoryDiscovery> {
    const input = repositoryDiscoveryInputSchema.safeParse(value);
    if (!input.success) throw new GitHubDeliveryError("GITHUB_DELIVERY_INPUT_INVALID");
    const { owner, repository, pullNumber, reviewerIds, reviewerLogins } = input.data;
    const signal = AbortSignal.timeout(20000);
    const installed = z
      .object({
        id: identifier,
        app_id: identifier,
        account: z.object({ login: z.string().min(1).max(100) }),
        suspended_at: z.null(),
        permissions: tokenSchema.shape.permissions,
      })
      .safeParse(
        await githubJson(
          `/repos/${owner}/${repository}/installation`,
          githubAppJwt(this.credentials),
          signal,
          this.fetch_,
        ),
      );
    if (
      !installed.success ||
      installed.data.app_id !== Number(this.credentials.appId) ||
      installed.data.account.login.toLowerCase() !== owner.toLowerCase()
    )
      throw new GitHubDeliveryError("GITHUB_DELIVERY_UNAVAILABLE");
    // Initial discovery narrows by one repository name; subsequent persisted
    // reads use the verified immutable ID. No installation-wide token is minted.
    const minted = await this.mint(installed.data.id, { repositories: [repository] }, signal);
    const target = minted.repositories[0];
    if (!target || target.full_name.toLowerCase() !== `${owner}/${repository}`.toLowerCase())
      throw new GitHubDeliveryError("GITHUB_DELIVERY_UNAVAILABLE");
    await this.verify(
      { repositoryId: target.id, policy: { owner, repository } },
      minted.token,
      signal,
    );
    const accounts = reviewerLogins ?? reviewerIds ?? [];
    const results = await Promise.allSettled([
      new GitHubDeliveryReader(minted.token, this.fetch_).discoverChecks(input.data, signal),
      Promise.all(
        accounts.map(async (account) => {
          const path = typeof account === "string" ? `/users/${account}` : `/user/${account}`;
          // Only public account identity is needed, not profile/email data or
          // additional GitHub permissions. The response is reduced immediately.
          const user = z
            .object({
              id: identifier,
              login: repositoryDiscoveryInputSchema.shape.owner,
              type: z.literal("User"),
            })
            .safeParse(await githubJson(path, minted.token, signal, this.fetch_));
          if (
            !user.success ||
            (typeof account === "number"
              ? user.data.id !== account
              : user.data.login.toLowerCase() !== account.toLowerCase())
          )
            throw new GitHubDeliveryError("GITHUB_DELIVERY_UNAVAILABLE");
          return { id: user.data.id, login: user.data.login };
        }),
      ),
    ]);
    const checks = results[0];
    const reviewers = results[1];
    if (
      checks.status !== "fulfilled" ||
      reviewers.status !== "fulfilled" ||
      new Set(reviewers.value.map((user) => user.id)).size !== reviewers.value.length
    )
      throw new GitHubDeliveryError("GITHUB_DELIVERY_UNAVAILABLE");
    return {
      owner,
      repository,
      repositoryId: target.id,
      installationId: installed.data.id,
      pullNumber,
      ...checks.value,
      reviewers: reviewers.value,
    };
  }
}
