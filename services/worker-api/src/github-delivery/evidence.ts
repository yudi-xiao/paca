import * as z from "zod";

const identifier = z.number().int().positive().safe();
export const githubDeliveryPolicySchema = z
  .object({
    owner: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/),
    repository: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_.-]+$/)
      .refine((value) => value !== "." && value !== ".."),
    // Pin both the name and the trusted publishing App. A same-name check from
    // another App must never satisfy this project's policy.
    requiredChecks: z
      .array(z.object({ name: z.string().min(1).max(200), appId: identifier }).strict())
      .min(1)
      .max(20),
    maxCheckAgeSeconds: z.number().int().min(60).max(604800).default(86400),
    requiredApprovals: z.number().int().min(0).max(5),
    reviewerIds: z.array(identifier).max(20),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.requiredChecks.map((check) => `${check.appId}:${check.name}`)).size !==
      value.requiredChecks.length
    )
      context.addIssue({ code: "custom", message: "Duplicate checks" });
    if (
      new Set(value.reviewerIds).size !== value.reviewerIds.length ||
      value.requiredApprovals > value.reviewerIds.length
    )
      context.addIssue({ code: "custom", message: "Invalid reviewer policy" });
  });
export type GitHubDeliveryPolicy = z.infer<typeof githubDeliveryPolicySchema>;
export const githubDeliveryReferenceSchema = z
  .object({ pullNumber: identifier, headSha: z.string().regex(/^[a-f0-9]{40}$/) })
  .strict();
export type GitHubDeliveryReference = z.infer<typeof githubDeliveryReferenceSchema>;
export class GitHubDeliveryError extends Error {
  constructor(
    readonly code:
      | "GITHUB_DELIVERY_INPUT_INVALID"
      | "GITHUB_DELIVERY_UNAVAILABLE"
      | "GITHUB_DELIVERY_APP_NOT_CONFIGURED"
      | "GITHUB_DELIVERY_TOO_LARGE",
  ) {
    super(code);
    this.name = "GitHubDeliveryError";
  }
}
export const pullSchema = z.object({
  number: identifier,
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  merged: z.boolean(),
  user: z.object({ id: identifier }),
  head: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }),
  base: z.object({ repo: z.object({ full_name: z.string().min(1).max(200) }) }),
});
export const checkSchema = z.object({
  id: identifier,
  name: z.string().min(1).max(200),
  head_sha: z.string().regex(/^[a-f0-9]{40}$/),
  status: z.string().min(1).max(50),
  conclusion: z.string().max(50).nullable(),
  completed_at: z.iso.datetime({ offset: true }).nullable(),
  app: z.object({ id: identifier }),
});
export const reviewSchema = z.object({
  id: identifier,
  user: z.object({ id: identifier }).nullable(),
  state: z.string().min(1).max(50),
  commit_id: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .nullable(),
  submitted_at: z.iso.datetime({ offset: true }).nullable(),
});
export type GitHubPull = z.infer<typeof pullSchema>;
export type GitHubCheck = z.infer<typeof checkSchema>;
export type GitHubReview = z.infer<typeof reviewSchema>;
export type GitHubDeliverySnapshot = {
  pull: GitHubPull;
  checks: GitHubCheck[];
  reviews: GitHubReview[];
  complete: boolean;
  observedAt: Date;
};
export type GitHubDeliveryEvidence = {
  repository: string;
  pullNumber: number;
  headSha: string;
  pullUrl: string;
  observedAt: string;
  state: "awaiting_acceptance" | "waiting" | "needs_changes" | "stale" | "unavailable";
  reasons: string[];
  checks: Array<{
    name: string;
    appId: number;
    runId: number | null;
    state: "passed" | "pending" | "failed" | "missing" | "stale";
  }>;
  approvalCount: number;
};
export function evaluateGitHubDelivery(
  policy: GitHubDeliveryPolicy,
  reference: GitHubDeliveryReference,
  snapshot: GitHubDeliverySnapshot,
  now = new Date(),
): GitHubDeliveryEvidence {
  if (
    !githubDeliveryPolicySchema.safeParse(policy).success ||
    !githubDeliveryReferenceSchema.safeParse(reference).success
  )
    throw new GitHubDeliveryError("GITHUB_DELIVERY_INPUT_INVALID");
  const repository = `${policy.owner}/${policy.repository}`;
  const evidence: GitHubDeliveryEvidence = {
    repository,
    pullNumber: reference.pullNumber,
    headSha: reference.headSha,
    pullUrl: `https://github.com/${repository}/pull/${reference.pullNumber}`,
    observedAt: Number.isFinite(snapshot.observedAt.getTime())
      ? snapshot.observedAt.toISOString()
      : "",
    state: "waiting",
    reasons: [],
    checks: [],
    approvalCount: 0,
  };
  if (
    !snapshot.complete ||
    !Number.isFinite(snapshot.observedAt.getTime()) ||
    now.getTime() - snapshot.observedAt.getTime() > 60000 ||
    snapshot.observedAt.getTime() > now.getTime() + 5000
  ) {
    return { ...evidence, state: "unavailable", reasons: ["EVIDENCE_INCOMPLETE_OR_STALE"] };
  }
  if (
    snapshot.pull.base.repo.full_name.toLowerCase() !== repository.toLowerCase() ||
    snapshot.pull.number !== reference.pullNumber
  )
    return { ...evidence, state: "unavailable", reasons: ["REPOSITORY_OR_PR_MISMATCH"] };
  if (snapshot.pull.head.sha !== reference.headSha)
    return { ...evidence, state: "stale", reasons: ["PR_HEAD_CHANGED"] };
  if (snapshot.pull.draft) evidence.reasons.push("PR_IS_DRAFT");
  if (snapshot.pull.state === "closed" && !snapshot.pull.merged)
    evidence.reasons.push("PR_CLOSED_WITHOUT_MERGE");
  for (const required of policy.requiredChecks) {
    const check = snapshot.checks
      .filter(
        (value) =>
          value.head_sha === reference.headSha &&
          value.name === required.name &&
          value.app.id === required.appId,
      )
      .sort((a, b) => b.id - a.id)[0];
    const state = !check
      ? "missing"
      : check.status !== "completed"
        ? "pending"
        : check.conclusion !== "success"
          ? "failed"
          : !check.completed_at ||
              !Number.isFinite(Date.parse(check.completed_at)) ||
              Date.parse(check.completed_at) > now.getTime() + 5000 ||
              now.getTime() - Date.parse(check.completed_at) > policy.maxCheckAgeSeconds * 1000
            ? "stale"
            : "passed";
    evidence.checks.push({
      name: required.name,
      appId: required.appId,
      runId: check?.id ?? null,
      state,
    });
    if (state !== "passed")
      evidence.reasons.push(
        state === "failed"
          ? "REQUIRED_CHECK_FAILED"
          : state === "stale"
            ? "REQUIRED_CHECK_STALE"
            : "REQUIRED_CHECK_NOT_PASSED",
      );
  }
  const latest = new Map<number, GitHubReview>();
  for (const review of snapshot.reviews) {
    if (
      !review.user ||
      !review.submitted_at ||
      !policy.reviewerIds.includes(review.user.id) ||
      review.user.id === snapshot.pull.user.id ||
      !["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)
    )
      continue;
    const current = latest.get(review.user.id);
    if (
      !current ||
      Date.parse(review.submitted_at) > Date.parse(current.submitted_at ?? "") ||
      (review.submitted_at === current.submitted_at && review.id > current.id)
    )
      latest.set(review.user.id, review);
  }
  for (const review of latest.values()) {
    if (review.state === "CHANGES_REQUESTED") evidence.reasons.push("REVIEW_CHANGES_REQUESTED");
    if (review.state === "APPROVED" && review.commit_id === reference.headSha)
      evidence.approvalCount++;
  }
  if (evidence.approvalCount < policy.requiredApprovals)
    evidence.reasons.push("CURRENT_COMMIT_APPROVAL_REQUIRED");
  evidence.reasons = [...new Set(evidence.reasons)];
  evidence.state = evidence.reasons.some((reason) =>
    ["REQUIRED_CHECK_FAILED", "REVIEW_CHANGES_REQUESTED", "PR_CLOSED_WITHOUT_MERGE"].includes(
      reason,
    ),
  )
    ? "needs_changes"
    : evidence.reasons.length
      ? "waiting"
      : "awaiting_acceptance";
  // This evaluator never grants human acceptance or mutates task state.
  return evidence;
}
