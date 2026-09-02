import {
  type AgentTaskLease,
  type AgentTaskLeaseCommand,
  type AgentTaskLeaseResult,
  agentTaskLeaseCommandSchema,
} from "./protocol";

export const agentTaskLeaseErrorCodes = {
  authorizationExpired: "AGENT_TASK_AUTHORIZATION_EXPIRED",
  checkpointSequenceInvalid: "AGENT_TASK_CHECKPOINT_SEQUENCE_INVALID",
  idempotencyConflict: "AGENT_TASK_IDEMPOTENCY_CONFLICT",
  inputInvalid: "AGENT_TASK_LEASE_INPUT_INVALID",
  leaseConflict: "AGENT_TASK_LEASE_CONFLICT",
  leaseExpired: "AGENT_TASK_LEASE_EXPIRED",
  leaseNotFound: "AGENT_TASK_LEASE_NOT_FOUND",
  leaseOwnerMismatch: "AGENT_TASK_LEASE_OWNER_MISMATCH",
  leaseScopeMismatch: "AGENT_TASK_LEASE_SCOPE_MISMATCH",
  leaseTerminal: "AGENT_TASK_LEASE_TERMINAL",
  taskNotFound: "AGENT_TASK_NOT_FOUND",
} as const;

export type AgentTaskLeaseErrorCode =
  (typeof agentTaskLeaseErrorCodes)[keyof typeof agentTaskLeaseErrorCodes];

export class AgentTaskLeaseError extends Error {
  constructor(readonly code: AgentTaskLeaseErrorCode) {
    super(code);
    this.name = "AgentTaskLeaseError";
  }
}

export type AgentTaskLeaseActor = {
  agentId: string;
  hostId: string;
};

export type AgentTaskLeaseExecution = {
  actor: AgentTaskLeaseActor;
  command: AgentTaskLeaseCommand;
  authorizationExpiresAt: Date;
  now: Date;
};

export interface AgentTaskLeaseRepository {
  execute(input: AgentTaskLeaseExecution): Promise<AgentTaskLeaseResult>;
}

export class AgentTaskLeaseService {
  constructor(private readonly repository: AgentTaskLeaseRepository) {}

  async execute(
    actor: AgentTaskLeaseActor,
    value: unknown,
    authorizationExpiresAt: Date,
    now = new Date(),
  ): Promise<AgentTaskLeaseResult> {
    const parsed = agentTaskLeaseCommandSchema.safeParse(value);
    if (!parsed.success) {
      throw new AgentTaskLeaseError(agentTaskLeaseErrorCodes.inputInvalid);
    }
    if (
      authorizationExpiresAt.getTime() <= now.getTime() ||
      Date.parse(parsed.data.validUntil) <= now.getTime()
    ) {
      throw new AgentTaskLeaseError(agentTaskLeaseErrorCodes.authorizationExpired);
    }
    return this.repository.execute({
      actor,
      command: parsed.data,
      authorizationExpiresAt,
      now,
    });
  }
}

export type { AgentTaskLease, AgentTaskLeaseResult };
