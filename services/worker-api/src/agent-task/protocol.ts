import * as z from "zod";

export const agentHarnessKinds = [
  "cloudflare-agent",
  "codex",
  "claude-code",
  "deepseek",
  "custom",
] as const;

export type AgentHarnessKind = (typeof agentHarnessKinds)[number];

const scopeSchema = z
  .object({
    organizationId: z.string().min(1).max(255),
    projectId: z.uuid(),
    taskId: z.uuid(),
    operationMode: z.literal("execute"),
    validUntil: z.iso.datetime(),
    requestId: z.uuid(),
  })
  .strict();

export const agentHarnessSchema = z
  .object({
    kind: z.enum(agentHarnessKinds),
    version: z.string().min(1).max(100).optional(),
    instanceId: z.string().min(1).max(255).optional(),
  })
  .strict();

const artifactKeySchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), {
    message: "AGENT_TASK_ARTIFACT_KEY_INVALID",
  });

const leaseDurationSchema = z
  .number()
  .int()
  .min(5_000)
  .max(5 * 60_000);
const leaseScopedSchema = scopeSchema.extend({ leaseId: z.uuid() });

export const agentTaskLeaseCommandSchema = z.discriminatedUnion("action", [
  scopeSchema.extend({
    action: z.literal("claim"),
    leaseDurationMs: leaseDurationSchema,
    harness: agentHarnessSchema,
  }),
  leaseScopedSchema.extend({
    action: z.literal("renew"),
    leaseDurationMs: leaseDurationSchema,
  }),
  leaseScopedSchema.extend({
    action: z.literal("checkpoint"),
    sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    checkpointKey: artifactKeySchema.nullable().optional(),
    summary: z.string().max(4_000).nullable().optional(),
    artifactKeys: z.array(artifactKeySchema).max(32).default([]),
  }),
  leaseScopedSchema.extend({
    action: z.literal("complete"),
    summary: z.string().max(16_000).nullable().optional(),
    artifactKeys: z.array(artifactKeySchema).max(32).default([]),
  }),
  leaseScopedSchema.extend({
    action: z.literal("fail"),
    errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/),
    summary: z.string().max(16_000).nullable().optional(),
    artifactKeys: z.array(artifactKeySchema).max(32).default([]),
  }),
  leaseScopedSchema.extend({
    action: z.literal("cancel_ack"),
    summary: z.string().max(4_000).nullable().optional(),
  }),
]);

export type AgentTaskLeaseCommand = z.infer<typeof agentTaskLeaseCommandSchema>;

export const agentTaskLeaseStatuses = [
  "active",
  "cancelled",
  "completed",
  "expired",
  "failed",
] as const;

export type AgentTaskLeaseStatus = (typeof agentTaskLeaseStatuses)[number];

export type AgentTaskLease = {
  id: string;
  organizationId: string;
  projectId: string;
  taskId: string;
  agentId: string;
  hostId: string;
  harness: {
    kind: AgentHarnessKind;
    version: string | null;
    instanceId: string | null;
  };
  status: AgentTaskLeaseStatus;
  version: number;
  lastCheckpointSequence: number;
  leaseExpiresAt: Date;
  claimedAt: Date;
  finishedAt: Date | null;
  errorCode: string | null;
  resultSummary: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AgentTaskLeaseResult = {
  duplicate: boolean;
  lease: AgentTaskLease;
};

export function agentTaskLeaseCommandFingerprint(command: AgentTaskLeaseCommand): string {
  return JSON.stringify(command);
}
