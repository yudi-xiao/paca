import * as z from "zod";

import { agentHarnessKinds, agentHarnessSchema } from "./protocol";

export const AGENT_HOST_HEARTBEAT_TTL_MS = 2 * 60_000;
export const AGENT_HOST_EXECUTION_LABEL = "task:execute";
export const MAX_AGENT_HOST_LABELS = 32;

export const agentHostLabelSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/);

const labelsSchema = z.array(agentHostLabelSchema).max(MAX_AGENT_HOST_LABELS);

export const agentHostHeartbeatSchema = z
  .object({
    harnesses: z.array(agentHarnessSchema).min(1).max(16),
    labels: labelsSchema.default([]),
  })
  .strict();

export const agentHostApprovalSchema = z
  .object({
    approved_labels: labelsSchema,
  })
  .strict();

export const agentTaskRequirementSchema = z
  .object({
    required_labels: labelsSchema,
  })
  .strict();

export type AgentHostHeartbeat = z.infer<typeof agentHostHeartbeatSchema>;

export type AgentHostRuntimeProfile = {
  hostId: string;
  hostName: string | null;
  hostStatus: string;
  approvedLabels: string[];
  reportedLabels: string[];
  reportedHarnessKinds: string[];
  effectiveLabels: string[];
  labelsVersion: number;
  approvedBy: string | null;
  approvedAt: Date | null;
  lastHeartbeatAt: Date | null;
  heartbeatExpiresAt: Date | null;
  online: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type AgentTaskRequirement = {
  taskId: string;
  projectId: string;
  requiredLabels: string[];
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export const agentHostRuntimeErrorCodes = {
  hostInactive: "AGENT_HOST_INACTIVE",
  hostNotFound: "AGENT_HOST_NOT_FOUND",
  inputInvalid: "AGENT_HOST_RUNTIME_INPUT_INVALID",
  taskNotFound: "AGENT_TASK_NOT_FOUND",
} as const;

export type AgentHostRuntimeErrorCode =
  (typeof agentHostRuntimeErrorCodes)[keyof typeof agentHostRuntimeErrorCodes];

export class AgentHostRuntimeError extends Error {
  constructor(readonly code: AgentHostRuntimeErrorCode) {
    super(code);
    this.name = "AgentHostRuntimeError";
  }
}

export type AgentHostRuntimeRepository = {
  heartbeat(hostId: string, input: AgentHostHeartbeat, now: Date): Promise<AgentHostRuntimeProfile>;
  approveLabels(
    hostId: string,
    approvedBy: string,
    labels: string[],
    now: Date,
  ): Promise<AgentHostRuntimeProfile>;
  list(now: Date): Promise<AgentHostRuntimeProfile[]>;
  matchTasks(hostId: string, taskIds: readonly string[], now: Date): Promise<Set<string>>;
  getTaskRequirement(projectId: string, taskId: string): Promise<AgentTaskRequirement | null>;
  setTaskRequirement(
    projectId: string,
    taskId: string,
    updatedBy: string,
    labels: string[],
    now: Date,
  ): Promise<AgentTaskRequirement>;
};

export function effectiveAgentHostLabels(
  approvedLabels: readonly string[],
  reportedLabels: readonly string[],
): string[] {
  const approved = new Set(approvedLabels);
  return [...new Set(reportedLabels.filter((label) => approved.has(label)))].sort();
}

export function agentHostMatchesTask(
  profile: Pick<AgentHostRuntimeProfile, "effectiveLabels" | "online">,
  requiredLabels: readonly string[],
): boolean {
  if (!profile.online) return false;
  const effective = new Set(profile.effectiveLabels);
  return (
    effective.has(AGENT_HOST_EXECUTION_LABEL) &&
    requiredLabels.every((label) => effective.has(label))
  );
}

function normalizedLabels(labels: readonly string[]): string[] {
  const parsed = labelsSchema.safeParse(labels);
  if (!parsed.success) throw new AgentHostRuntimeError(agentHostRuntimeErrorCodes.inputInvalid);
  return [...new Set(parsed.data)].sort();
}

function normalizedHeartbeat(value: unknown): AgentHostHeartbeat {
  const parsed = agentHostHeartbeatSchema.safeParse(value);
  if (!parsed.success) throw new AgentHostRuntimeError(agentHostRuntimeErrorCodes.inputInvalid);
  const harnessKinds = [...new Set(parsed.data.harnesses.map(({ kind }) => kind))];
  return {
    harnesses: harnessKinds.map((kind) => ({ kind })),
    labels: normalizedLabels([
      ...parsed.data.labels,
      ...harnessKinds.map((kind) => `harness:${kind}`),
    ]),
  };
}

export class AgentHostRuntimeService {
  constructor(private readonly repository: AgentHostRuntimeRepository) {}

  heartbeat(hostId: string, value: unknown, now = new Date()): Promise<AgentHostRuntimeProfile> {
    return this.repository.heartbeat(hostId, normalizedHeartbeat(value), now);
  }

  approveLabels(
    hostId: string,
    approvedBy: string,
    value: unknown,
    now = new Date(),
  ): Promise<AgentHostRuntimeProfile> {
    const parsed = agentHostApprovalSchema.safeParse(value);
    if (!parsed.success) throw new AgentHostRuntimeError(agentHostRuntimeErrorCodes.inputInvalid);
    return this.repository.approveLabels(
      hostId,
      approvedBy,
      normalizedLabels(parsed.data.approved_labels),
      now,
    );
  }

  list(now = new Date()): Promise<AgentHostRuntimeProfile[]> {
    return this.repository.list(now);
  }

  matchTasks(hostId: string, taskIds: readonly string[], now = new Date()): Promise<Set<string>> {
    return this.repository.matchTasks(hostId, [...new Set(taskIds)].slice(0, 100), now);
  }

  getTaskRequirement(projectId: string, taskId: string): Promise<AgentTaskRequirement | null> {
    return this.repository.getTaskRequirement(projectId, taskId);
  }

  setTaskRequirement(
    projectId: string,
    taskId: string,
    updatedBy: string,
    value: unknown,
    now = new Date(),
  ): Promise<AgentTaskRequirement> {
    const parsed = agentTaskRequirementSchema.safeParse(value);
    if (!parsed.success) throw new AgentHostRuntimeError(agentHostRuntimeErrorCodes.inputInvalid);
    return this.repository.setTaskRequirement(
      projectId,
      taskId,
      updatedBy,
      normalizedLabels(parsed.data.required_labels),
      now,
    );
  }
}

export function isAgentHarnessKind(value: string): value is (typeof agentHarnessKinds)[number] {
  return (agentHarnessKinds as readonly string[]).includes(value);
}
