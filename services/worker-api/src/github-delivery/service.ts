import * as z from "zod";
import {
  GitHubDeliveryError,
  type GitHubDeliveryEvidence,
  type GitHubDeliveryPolicy,
  type GitHubDeliveryReference,
  githubDeliveryPolicySchema,
  githubDeliveryReferenceSchema,
} from "./evidence";

const identifier = z.number().int().positive().safe();
export const repositoryBindingInputSchema = z
  .object({
    requestId: z.uuid(),
    expectedVersion: z.number().int().nonnegative(),
    repositoryId: identifier,
    installationId: identifier,
    policy: githubDeliveryPolicySchema,
  })
  .strict();
export const deliverySubmissionSchema = githubDeliveryReferenceSchema
  .extend({
    requestId: z.uuid(),
    expectedVersion: z.number().int().nonnegative(),
    leaseId: z.uuid(),
  })
  .strict();
export const deliveryRefreshSchema = z
  .object({ requestId: z.uuid(), expectedVersion: z.number().int().positive() })
  .strict();
export const deliveryDecisionSchema = deliveryRefreshSchema
  .extend({
    decision: z.enum(["accept", "request_changes"]),
    note: z.string().trim().max(2000).default(""),
  })
  .strict();
export type RepositoryBindingInput = z.infer<typeof repositoryBindingInputSchema>;
export type DeliverySubmission = z.infer<typeof deliverySubmissionSchema>;
export type DeliveryDecision = z.infer<typeof deliveryDecisionSchema>;
export type RepositoryBinding = {
  projectId: string;
  repositoryId: number;
  installationId: number;
  policy: GitHubDeliveryPolicy;
  version: number;
  status: "active" | "revoked";
  updatedAt: Date;
};
export type CompletedDeliveryRunPage = {
  items: { leaseId: string; harnessKind: string; finishedAt: Date }[];
  nextCursor: string | null;
};
export interface CompletedDeliveryRunRepository {
  completedRuns(
    projectId: string,
    taskId: string,
    cursor?: string,
  ): Promise<CompletedDeliveryRunPage>;
}
export type TaskDelivery = {
  id: string;
  projectId: string;
  taskId: string;
  leaseId: string;
  repositoryId: number;
  policyVersion: number;
  version: number;
  reference: GitHubDeliveryReference;
  state: GitHubDeliveryEvidence["state"] | "accepted";
  evidence: GitHubDeliveryEvidence;
  acceptedBy: string | null;
  acceptedAt: Date | null;
  requestedChangesBy: string | null;
  requestedChangesAt: Date | null;
  reviewNote: string;
  updatedAt: Date;
};
export class DeliveryWorkflowError extends Error {
  constructor(
    readonly code:
      | "DELIVERY_BODY_TOO_LARGE"
      | "DELIVERY_INPUT_INVALID"
      | "DELIVERY_NOT_FOUND"
      | "DELIVERY_REPOSITORY_NOT_CONFIGURED"
      | "DELIVERY_VERSION_CONFLICT"
      | "DELIVERY_IDEMPOTENCY_CONFLICT"
      | "DELIVERY_RUN_NOT_COMPLETED"
      | "DELIVERY_SCOPE_MISMATCH"
      | "DELIVERY_EVIDENCE_NOT_READY"
      | "DELIVERY_PERMISSION_DENIED",
  ) {
    super(code);
    this.name = "DeliveryWorkflowError";
  }
}
export type DeliveryWrite = {
  projectId: string;
  taskId: string;
  actorId: string;
  requestId: string;
  fingerprint: string;
  expectedVersion: number;
  binding: RepositoryBinding;
  reference: GitHubDeliveryReference;
  leaseId: string;
  evidence: GitHubDeliveryEvidence;
  now: Date;
  action: "submit" | "refresh" | "accept" | "request_changes";
  note: string;
};
export interface GitHubDeliveryRepository {
  binding(projectId: string): Promise<RepositoryBinding | null>;
  delivery(projectId: string, taskId: string): Promise<TaskDelivery | null>;
  configure(
    projectId: string,
    actorId: string,
    input: RepositoryBindingInput,
    now: Date,
  ): Promise<RepositoryBinding>;
  write(input: DeliveryWrite): Promise<TaskDelivery>;
}
export interface GitHubDeliverySource {
  verifyRepository(input: RepositoryBindingInput): Promise<void>;
  inspect(
    binding: RepositoryBinding,
    reference: GitHubDeliveryReference,
  ): Promise<GitHubDeliveryEvidence>;
}
export type AssertDeliveryPermission = (
  projectId: string,
  actorId: string,
  configure: boolean,
) => Promise<void>;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new DeliveryWorkflowError("DELIVERY_INPUT_INVALID");
  return parsed.data;
}
function scope(projectId: string, taskId?: string) {
  if (
    !z.uuid().safeParse(projectId).success ||
    (taskId !== undefined && !z.uuid().safeParse(taskId).success)
  )
    throw new DeliveryWorkflowError("DELIVERY_INPUT_INVALID");
}
export function requireFreshDeliveryEvidence(
  binding: RepositoryBinding,
  reference: GitHubDeliveryReference,
  evidence: GitHubDeliveryEvidence,
  now: Date,
) {
  const observed = Date.parse(evidence.observedAt);
  if (
    evidence.repository.toLowerCase() !==
      `${binding.policy.owner}/${binding.policy.repository}`.toLowerCase() ||
    evidence.pullNumber !== reference.pullNumber ||
    evidence.headSha !== reference.headSha ||
    !Number.isFinite(observed) ||
    observed > now.getTime() + 5000 ||
    now.getTime() - observed > 60000
  )
    throw new DeliveryWorkflowError("DELIVERY_SCOPE_MISMATCH");
}
/** Domain orchestration consumes only ports. GitHub reads occur outside the
 * database transaction; the repository then compares both policy and delivery
 * versions, and permission is rechecked after external I/O. */
export class GitHubDeliveryService {
  constructor(
    private readonly repository: GitHubDeliveryRepository,
    private readonly source: GitHubDeliverySource,
    private readonly authorize: AssertDeliveryPermission,
  ) {}
  async configure(projectId: string, actorId: string, value: unknown) {
    scope(projectId);
    const input = parse(repositoryBindingInputSchema, value);
    await this.authorize(projectId, actorId, true);
    await this.source.verifyRepository(input);
    await this.authorize(projectId, actorId, true);
    return this.repository.configure(projectId, actorId, input, new Date());
  }
  async submit(projectId: string, taskId: string, actorId: string, value: unknown) {
    scope(projectId, taskId);
    const input = parse(deliverySubmissionSchema, value);
    return this.collect(
      projectId,
      taskId,
      actorId,
      "submit",
      input,
      { pullNumber: input.pullNumber, headSha: input.headSha },
      input.leaseId,
      "",
    );
  }
  async refresh(projectId: string, taskId: string, actorId: string, value: unknown) {
    scope(projectId, taskId);
    const input = parse(deliveryRefreshSchema, value);
    const current = await this.repository.delivery(projectId, taskId);
    if (!current) throw new DeliveryWorkflowError("DELIVERY_NOT_FOUND");
    return this.collect(
      projectId,
      taskId,
      actorId,
      "refresh",
      input,
      current.reference,
      current.leaseId,
      "",
    );
  }
  async decide(projectId: string, taskId: string, actorId: string, value: unknown) {
    scope(projectId, taskId);
    const input = parse(deliveryDecisionSchema, value);
    const current = await this.repository.delivery(projectId, taskId);
    if (!current) throw new DeliveryWorkflowError("DELIVERY_NOT_FOUND");
    // Acceptance always collects fresh GitHub evidence. The browser never
    // supplies an evidence payload or an accepted identity.
    return this.collect(
      projectId,
      taskId,
      actorId,
      input.decision,
      input,
      current.reference,
      current.leaseId,
      input.note,
    );
  }
  private async collect(
    projectId: string,
    taskId: string,
    actorId: string,
    action: DeliveryWrite["action"],
    command: { requestId: string; expectedVersion: number },
    reference: GitHubDeliveryReference,
    leaseId: string,
    note: string,
  ) {
    await this.authorize(projectId, actorId, false);
    const binding = await this.repository.binding(projectId);
    if (!binding || binding.status !== "active")
      throw new DeliveryWorkflowError("DELIVERY_REPOSITORY_NOT_CONFIGURED");
    let evidence: GitHubDeliveryEvidence;
    if (action === "request_changes") {
      const current = await this.repository.delivery(projectId, taskId);
      if (!current) throw new DeliveryWorkflowError("DELIVERY_NOT_FOUND");
      evidence = current.evidence;
    } else {
      try {
        evidence = await this.source.inspect(binding, reference);
      } catch (error) {
        if (!(error instanceof GitHubDeliveryError)) throw error;
        evidence = {
          repository: `${binding.policy.owner}/${binding.policy.repository}`,
          ...reference,
          pullUrl: `https://github.com/${binding.policy.owner}/${binding.policy.repository}/pull/${reference.pullNumber}`,
          observedAt: new Date().toISOString(),
          state: "unavailable",
          reasons: [error.code],
          checks: [],
          approvalCount: 0,
        };
      }
    }
    await this.authorize(projectId, actorId, false);
    const now = new Date();
    if (action !== "request_changes")
      requireFreshDeliveryEvidence(binding, reference, evidence, now);
    const saved = await this.repository.write({
      projectId,
      taskId,
      actorId,
      action,
      ...command,
      binding,
      reference,
      leaseId,
      evidence,
      now,
      note,
      fingerprint: JSON.stringify([
        action,
        projectId,
        taskId,
        actorId,
        command.expectedVersion,
        reference.pullNumber,
        reference.headSha,
        leaseId,
        note,
      ]),
    });
    if (action === "accept" && saved.state !== "accepted")
      throw new DeliveryWorkflowError("DELIVERY_EVIDENCE_NOT_READY");
    return saved;
  }
}
