import * as z from "zod";
import { githubDeliveryPolicySchema } from "./evidence";
import { type AssertDeliveryPermission, DeliveryWorkflowError } from "./service";

const identifier = z.number().int().positive().safe();
const login = githubDeliveryPolicySchema.shape.owner;
export const repositoryDiscoveryInputSchema = z
  .object({
    owner: login,
    repository: githubDeliveryPolicySchema.shape.repository,
    pullNumber: identifier,
    reviewerLogins: z.array(login).max(20).optional(),
    reviewerIds: z.array(identifier).max(20).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.reviewerLogins !== undefined && value.reviewerIds !== undefined)
      context.addIssue({ code: "custom", message: "Choose one reviewer selector" });
    if (
      value.reviewerLogins &&
      new Set(value.reviewerLogins.map((name) => name.toLowerCase())).size !==
        value.reviewerLogins.length
    )
      context.addIssue({ code: "custom", message: "Duplicate reviewer" });
    if (value.reviewerIds && new Set(value.reviewerIds).size !== value.reviewerIds.length)
      context.addIssue({ code: "custom", message: "Duplicate reviewer" });
  });
export type RepositoryDiscoveryInput = z.infer<typeof repositoryDiscoveryInputSchema>;
export const repositoryDiscoverySchema = z
  .object({
    owner: login,
    repository: githubDeliveryPolicySchema.shape.repository,
    repositoryId: identifier,
    installationId: identifier,
    pullNumber: identifier,
    headSha: z.string().regex(/^[a-f0-9]{40}$/),
    observedAt: z.iso.datetime({ offset: true }),
    checks: z
      .array(
        z
          .object({
            name: z.string().min(1).max(200),
            appId: identifier,
            appName: z.string().min(1).max(200).nullable(),
            appSlug: z
              .string()
              .regex(/^[a-z0-9][a-z0-9-]{0,99}$/)
              .nullable(),
          })
          .strict(),
      )
      .max(500),
    reviewers: z.array(z.object({ id: identifier, login }).strict()).max(20),
  })
  .strict();
export type RepositoryDiscovery = z.infer<typeof repositoryDiscoverySchema>;
export interface GitHubRepositoryDiscoverySource {
  discover(input: RepositoryDiscoveryInput): Promise<RepositoryDiscovery>;
}
export class GitHubRepositoryDiscoveryService {
  constructor(
    private readonly source: GitHubRepositoryDiscoverySource,
    private readonly authorize: AssertDeliveryPermission,
  ) {}
  async discover(projectId: string, actorId: string, value: unknown) {
    const input = repositoryDiscoveryInputSchema.safeParse(value);
    if (!z.uuid().safeParse(projectId).success || !input.success)
      throw new DeliveryWorkflowError("DELIVERY_INPUT_INVALID");
    await this.authorize(projectId, actorId, true);
    const raw = await this.source.discover(input.data);
    await this.authorize(projectId, actorId, true);
    const result = repositoryDiscoverySchema.safeParse(raw);
    if (
      !result.success ||
      result.data.owner.toLowerCase() !== input.data.owner.toLowerCase() ||
      result.data.repository.toLowerCase() !== input.data.repository.toLowerCase() ||
      result.data.pullNumber !== input.data.pullNumber
    )
      throw new DeliveryWorkflowError("DELIVERY_SCOPE_MISMATCH");
    const requested = input.data.reviewerLogins ?? input.data.reviewerIds ?? [];
    if (
      result.data.reviewers.length !== requested.length ||
      new Set(result.data.reviewers.map((user) => user.id)).size !== requested.length ||
      requested.some(
        (account) =>
          !result.data.reviewers.some((user) =>
            typeof account === "number"
              ? user.id === account
              : user.login.toLowerCase() === account.toLowerCase(),
          ),
      )
    )
      throw new DeliveryWorkflowError("DELIVERY_SCOPE_MISMATCH");
    return result.data;
  }
}
