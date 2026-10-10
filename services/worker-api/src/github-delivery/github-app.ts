import { Buffer } from "node:buffer";
import { createPrivateKey, sign } from "node:crypto";
import * as z from "zod";
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
export class GitHubAppDeliverySource implements GitHubDeliverySource {
  constructor(
    private readonly credentials: GitHubAppCredentials,
    private readonly fetch_: typeof fetch = globalThis.fetch,
  ) {}
  private async token(target: Target, signal: AbortSignal): Promise<string> {
    const parsed = tokenSchema.safeParse(
      await githubJson(
        `/app/installations/${target.installationId}/access_tokens`,
        githubAppJwt(this.credentials),
        signal,
        this.fetch_,
        { repository_ids: [target.repositoryId], permissions },
      ),
    );
    if (!parsed.success) throw new GitHubDeliveryError("GITHUB_DELIVERY_UNAVAILABLE");
    const repository = parsed.data.repositories[0];
    const expires = Date.parse(parsed.data.expires_at);
    if (
      !repository ||
      repository.id !== target.repositoryId ||
      repository.full_name.toLowerCase() !==
        `${target.policy.owner}/${target.policy.repository}`.toLowerCase() ||
      expires < Date.now() + 30000 ||
      expires > Date.now() + 3900000
    )
      throw new GitHubDeliveryError("GITHUB_DELIVERY_UNAVAILABLE");
    return parsed.data.token;
  }
  private async verify(target: Target, token: string, signal: AbortSignal) {
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
}
