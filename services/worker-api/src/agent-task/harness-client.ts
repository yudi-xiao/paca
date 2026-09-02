import * as z from "zod";

import { type DelegatedAgentConfig, executeAgentCapability } from "../agent-auth/agent-client";
import {
  type AgentHarnessKind,
  type AgentTaskLeaseCommand,
  type AgentTaskLeaseResult,
  agentHarnessKinds,
  agentHarnessSchema,
  agentTaskLeaseCommandSchema,
  agentTaskLeaseStatuses,
} from "./protocol";

type JsonRecord = Record<string, unknown>;

const resultSchema = z
  .object({
    duplicate: z.boolean(),
    lease: z
      .object({
        id: z.uuid(),
        organizationId: z.string().min(1),
        projectId: z.uuid(),
        taskId: z.uuid(),
        agentId: z.string().min(1),
        hostId: z.string().min(1),
        harness: z
          .object({
            kind: z.enum(agentHarnessKinds),
            version: z.string().nullable(),
            instanceId: z.string().nullable(),
          })
          .strict(),
        status: z.enum(agentTaskLeaseStatuses),
        version: z.number().int().min(1),
        lastCheckpointSequence: z.number().int().min(0),
        leaseExpiresAt: z.coerce.date(),
        claimedAt: z.coerce.date(),
        finishedAt: z.coerce.date().nullable(),
        errorCode: z.string().nullable(),
        resultSummary: z.string().nullable(),
        createdAt: z.coerce.date(),
        updatedAt: z.coerce.date(),
      })
      .strict(),
  })
  .strict();

export type AgentTaskHarnessIdentity = {
  kind: AgentHarnessKind;
  version?: string;
  instanceId?: string;
};

export type AgentTaskExecutionScope = {
  organizationId: string;
  projectId: string;
  taskId: string;
  validUntil: string;
};

export interface AgentTaskHarnessTransport {
  execute(command: AgentTaskLeaseCommand): Promise<unknown>;
}

export class AgentTaskHarnessProtocolError extends Error {
  constructor(
    readonly code: "AGENT_TASK_HARNESS_INPUT_INVALID" | "AGENT_TASK_HARNESS_RESULT_INVALID",
  ) {
    super(code);
    this.name = "AgentTaskHarnessProtocolError";
  }
}

function commandScope(scope: AgentTaskExecutionScope) {
  return { ...scope, operationMode: "execute" as const };
}

function resultValue(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return (value as JsonRecord).data ?? value;
}

export class AgentTaskHarnessClient {
  readonly harness: AgentTaskHarnessIdentity;

  constructor(
    private readonly transport: AgentTaskHarnessTransport,
    harness: AgentTaskHarnessIdentity,
  ) {
    const parsed = agentHarnessSchema.safeParse(harness);
    if (!parsed.success) {
      throw new AgentTaskHarnessProtocolError("AGENT_TASK_HARNESS_INPUT_INVALID");
    }
    this.harness = parsed.data;
  }

  claim(
    scope: AgentTaskExecutionScope,
    input: { requestId: string; leaseDurationMs: number },
  ): Promise<AgentTaskLeaseResult> {
    return this.execute({
      ...commandScope(scope),
      ...input,
      action: "claim",
      harness: this.harness,
    });
  }

  renew(
    scope: AgentTaskExecutionScope,
    input: { leaseId: string; requestId: string; leaseDurationMs: number },
  ): Promise<AgentTaskLeaseResult> {
    return this.execute({ ...commandScope(scope), ...input, action: "renew" });
  }

  checkpoint(
    scope: AgentTaskExecutionScope,
    input: {
      leaseId: string;
      requestId: string;
      sequence: number;
      checkpointKey?: string | null;
      summary?: string | null;
      artifactKeys?: string[];
    },
  ): Promise<AgentTaskLeaseResult> {
    return this.execute({ ...commandScope(scope), ...input, action: "checkpoint" });
  }

  complete(
    scope: AgentTaskExecutionScope,
    input: {
      leaseId: string;
      requestId: string;
      summary?: string | null;
      artifactKeys?: string[];
    },
  ): Promise<AgentTaskLeaseResult> {
    return this.execute({ ...commandScope(scope), ...input, action: "complete" });
  }

  fail(
    scope: AgentTaskExecutionScope,
    input: {
      leaseId: string;
      requestId: string;
      errorCode: string;
      summary?: string | null;
      artifactKeys?: string[];
    },
  ): Promise<AgentTaskLeaseResult> {
    return this.execute({ ...commandScope(scope), ...input, action: "fail" });
  }

  cancelAck(
    scope: AgentTaskExecutionScope,
    input: { leaseId: string; requestId: string; summary?: string | null },
  ): Promise<AgentTaskLeaseResult> {
    return this.execute({ ...commandScope(scope), ...input, action: "cancel_ack" });
  }

  async execute(value: unknown): Promise<AgentTaskLeaseResult> {
    const command = agentTaskLeaseCommandSchema.safeParse(value);
    if (!command.success) {
      throw new AgentTaskHarnessProtocolError("AGENT_TASK_HARNESS_INPUT_INVALID");
    }
    if (
      command.data.action === "claim" &&
      (command.data.harness.kind !== this.harness.kind ||
        command.data.harness.version !== this.harness.version ||
        command.data.harness.instanceId !== this.harness.instanceId)
    ) {
      throw new AgentTaskHarnessProtocolError("AGENT_TASK_HARNESS_INPUT_INVALID");
    }
    const result = resultSchema.safeParse(resultValue(await this.transport.execute(command.data)));
    if (!result.success) {
      throw new AgentTaskHarnessProtocolError("AGENT_TASK_HARNESS_RESULT_INVALID");
    }
    return result.data;
  }
}

export function delegatedAgentTaskHarnessTransport(
  config: DelegatedAgentConfig,
  fetch?: typeof globalThis.fetch,
): AgentTaskHarnessTransport {
  return {
    execute: (command) =>
      executeAgentCapability({
        config,
        capability: "task.execute",
        arguments: { ...command },
        fetch,
      }),
  };
}
