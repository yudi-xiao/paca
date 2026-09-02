import * as z from "zod";

import {
  type DelegatedAgentConfig,
  executeAgentCapability,
  fetchWithDelegatedAgent,
} from "../agent-auth/agent-client";
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

const discoveredTaskSchema = z
  .object({
    organization_id: z.string().min(1),
    project_id: z.uuid(),
    task_id: z.uuid(),
    task_number: z.number().int().positive(),
    title: z.string().min(1),
    status_id: z.uuid().nullable(),
    task_updated_at: z.coerce.date(),
    valid_until: z.iso.datetime(),
    availability: z.enum(["claimable", "owned"]),
    lease: z
      .object({
        id: z.uuid(),
        harness_kind: z.enum(agentHarnessKinds),
        harness_version: z.string().nullable(),
        harness_instance_id: z.string().nullable(),
        status: z.literal("active"),
        version: z.number().int().min(1),
        last_checkpoint_sequence: z.number().int().min(0),
        lease_expires_at: z.coerce.date(),
      })
      .strict()
      .nullable(),
  })
  .strict();

const discoveryResultSchema = z.union([
  z.array(discoveredTaskSchema),
  z.object({ data: z.array(discoveredTaskSchema) }).passthrough(),
]);

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
  discover?(): Promise<unknown>;
}

export class AgentTaskHarnessProtocolError extends Error {
  constructor(
    readonly code:
      | "AGENT_TASK_HARNESS_DISCOVERY_UNAVAILABLE"
      | "AGENT_TASK_HARNESS_INPUT_INVALID"
      | "AGENT_TASK_HARNESS_RESULT_INVALID",
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

  async discover(): Promise<z.infer<typeof discoveredTaskSchema>[]> {
    if (!this.transport.discover) {
      throw new AgentTaskHarnessProtocolError("AGENT_TASK_HARNESS_DISCOVERY_UNAVAILABLE");
    }
    const result = discoveryResultSchema.safeParse(await this.transport.discover());
    if (!result.success) {
      throw new AgentTaskHarnessProtocolError("AGENT_TASK_HARNESS_RESULT_INVALID");
    }
    return Array.isArray(result.data) ? result.data : result.data.data;
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
    discover: async () => {
      const response = await fetchWithDelegatedAgent({
        config,
        path: "/api/v1/agent/tasks/claimable",
        capabilities: ["task.execute"],
        fetch,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new AgentTaskHarnessProtocolError("AGENT_TASK_HARNESS_DISCOVERY_UNAVAILABLE");
      }
      return body;
    },
  };
}
