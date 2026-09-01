import * as z from "zod";

export const agentRunStatuses = [
  "queued",
  "running",
  "waiting",
  "cancelling",
  "cancelled",
  "succeeded",
  "failed",
] as const;

export type AgentRunStatus = (typeof agentRunStatuses)[number];

export const agentRunCreateSchema = z
  .object({
    runId: z.uuid(),
    idempotencyKey: z.uuid(),
    requestHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    agentId: z.string().min(1).max(255),
    workflowId: z.uuid(),
    organizationId: z.string().min(1).max(255),
    projectId: z.uuid(),
    documentId: z.uuid().nullable().optional(),
    kind: z.literal("document.edit"),
  })
  .strict();

export type AgentRunCreate = z.infer<typeof agentRunCreateSchema>;

export const agentRunTransitionSchema = z
  .object({
    transitionId: z.uuid(),
    runId: z.uuid(),
    status: z.enum(agentRunStatuses),
    errorCode: z.string().min(1).max(100).nullable().optional(),
  })
  .strict();

export type AgentRunTransition = z.infer<typeof agentRunTransitionSchema>;

export type AgentRunRecord = {
  runId: string;
  idempotencyKey: string;
  agentId: string;
  workflowId: string;
  organizationId: string;
  projectId: string;
  documentId: string | null;
  kind: "document.edit";
  status: AgentRunStatus;
  version: number;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  errorCode: string | null;
};

const transitions: Record<AgentRunStatus, ReadonlySet<AgentRunStatus>> = {
  queued: new Set(["running", "cancelled", "failed"]),
  running: new Set(["waiting", "cancelling", "succeeded", "failed"]),
  waiting: new Set(["running", "cancelling", "cancelled", "failed"]),
  cancelling: new Set(["cancelled", "failed"]),
  cancelled: new Set(),
  succeeded: new Set(),
  failed: new Set(),
};

export function canTransitionAgentRun(from: AgentRunStatus, to: AgentRunStatus): boolean {
  return transitions[from].has(to);
}

export function isTerminalAgentRunStatus(status: AgentRunStatus): boolean {
  return status === "cancelled" || status === "succeeded" || status === "failed";
}

export function agentRunCreateFingerprint(input: AgentRunCreate): string {
  return JSON.stringify([
    input.runId,
    input.requestHash,
    input.agentId,
    input.workflowId,
    input.organizationId,
    input.projectId,
    input.documentId ?? null,
    input.kind,
  ]);
}
