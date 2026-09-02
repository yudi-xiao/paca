import { and, eq, isNull, lte, sql } from "drizzle-orm";

import type { PacaDatabase } from "../database";
import {
  pacaAgentTaskLeaseEvents,
  pacaAgentTaskLeases,
  pacaProjects,
  pacaTasks,
} from "../db/schema";
import {
  type AgentTaskLease,
  type AgentTaskLeaseCommand,
  type AgentTaskLeaseResult,
  agentHarnessSchema,
  agentTaskLeaseCommandFingerprint,
} from "./protocol";
import {
  AgentTaskLeaseError,
  type AgentTaskLeaseErrorCode,
  type AgentTaskLeaseExecution,
  type AgentTaskLeaseRepository,
  agentTaskLeaseErrorCodes,
} from "./service";

type LeaseRow = typeof pacaAgentTaskLeases.$inferSelect;
type TransactionOutcome = AgentTaskLeaseResult | AgentTaskLeaseErrorCode;

function publicLease(row: LeaseRow): AgentTaskLease {
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    taskId: row.taskId,
    agentId: row.agentId,
    hostId: row.hostId,
    harness: {
      kind: agentHarnessSchema.shape.kind.parse(row.harnessKind),
      version: row.harnessVersion,
      instanceId: row.harnessInstanceId,
    },
    status: row.status,
    version: row.version,
    lastCheckpointSequence: row.lastCheckpointSequence,
    leaseExpiresAt: row.leaseExpiresAt,
    claimedAt: row.claimedAt,
    finishedAt: row.finishedAt,
    errorCode: row.errorCode,
    resultSummary: row.resultSummary,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function effectiveAuthorizationExpiry(input: AgentTaskLeaseExecution): Date {
  const commandExpiry = Date.parse(input.command.validUntil);
  return new Date(Math.min(commandExpiry, input.authorizationExpiresAt.getTime()));
}

function renewedExpiry(input: AgentTaskLeaseExecution, durationMs: number): Date {
  return new Date(
    Math.min(input.now.getTime() + durationMs, effectiveAuthorizationExpiry(input).getTime()),
  );
}

function eventValues(leaseId: string, command: AgentTaskLeaseCommand, fingerprint: string) {
  const checkpoint = command.action === "checkpoint" ? command : null;
  const terminal = command.action === "complete" || command.action === "fail" ? command : null;
  return {
    leaseId,
    requestId: command.requestId,
    requestFingerprint: fingerprint,
    action: command.action,
    sequence: checkpoint?.sequence ?? null,
    checkpointKey: checkpoint?.checkpointKey ?? null,
    summary:
      checkpoint?.summary ??
      terminal?.summary ??
      (command.action === "cancel_ack" ? command.summary : null) ??
      null,
    artifactKeys: checkpoint?.artifactKeys ?? terminal?.artifactKeys ?? [],
  };
}

export class PostgresAgentTaskLeaseRepository implements AgentTaskLeaseRepository {
  constructor(private readonly database: PacaDatabase) {}

  async execute(input: AgentTaskLeaseExecution): Promise<AgentTaskLeaseResult> {
    const fingerprint = agentTaskLeaseCommandFingerprint(input.command);
    const outcome = await this.database.transaction(
      async (transaction): Promise<TransactionOutcome> => {
        const findDuplicate = async (): Promise<TransactionOutcome | null> => {
          const [duplicateEvent] = await transaction
            .select({
              leaseId: pacaAgentTaskLeaseEvents.leaseId,
              requestFingerprint: pacaAgentTaskLeaseEvents.requestFingerprint,
            })
            .from(pacaAgentTaskLeaseEvents)
            .where(eq(pacaAgentTaskLeaseEvents.requestId, input.command.requestId))
            .limit(1);

          if (!duplicateEvent) return null;
          if (duplicateEvent.requestFingerprint !== fingerprint) {
            return agentTaskLeaseErrorCodes.idempotencyConflict;
          }
          const [duplicateLease] = await transaction
            .select()
            .from(pacaAgentTaskLeases)
            .where(eq(pacaAgentTaskLeases.id, duplicateEvent.leaseId))
            .limit(1);
          if (!duplicateLease) return agentTaskLeaseErrorCodes.leaseNotFound;
          if (
            duplicateLease.agentId !== input.actor.agentId ||
            duplicateLease.hostId !== input.actor.hostId
          ) {
            return agentTaskLeaseErrorCodes.leaseOwnerMismatch;
          }
          return { duplicate: true, lease: publicLease(duplicateLease) };
        };

        const duplicate = await findDuplicate();
        if (duplicate) return duplicate;

        if (input.command.action === "claim") {
          const [task] = await transaction
            .select({ id: pacaTasks.id })
            .from(pacaTasks)
            .innerJoin(
              pacaProjects,
              and(
                eq(pacaProjects.id, pacaTasks.projectId),
                eq(pacaProjects.organizationId, input.command.organizationId),
                eq(pacaProjects.status, "active"),
              ),
            )
            .where(
              and(
                eq(pacaTasks.id, input.command.taskId),
                eq(pacaTasks.projectId, input.command.projectId),
                isNull(pacaTasks.deletedAt),
              ),
            )
            .limit(1)
            .for("update", { of: pacaTasks });
          if (!task) return agentTaskLeaseErrorCodes.taskNotFound;

          // The task row is the serialization point for competing claims. A
          // retry may have inserted its event while this transaction waited.
          const duplicateAfterTaskLock = await findDuplicate();
          if (duplicateAfterTaskLock) return duplicateAfterTaskLock;

          await transaction
            .update(pacaAgentTaskLeases)
            .set({
              status: "expired",
              version: sql`${pacaAgentTaskLeases.version} + 1`,
              finishedAt: input.now,
              updatedAt: input.now,
            })
            .where(
              and(
                eq(pacaAgentTaskLeases.taskId, input.command.taskId),
                eq(pacaAgentTaskLeases.status, "active"),
                lte(pacaAgentTaskLeases.leaseExpiresAt, input.now),
              ),
            );

          const [active] = await transaction
            .select({ id: pacaAgentTaskLeases.id })
            .from(pacaAgentTaskLeases)
            .where(
              and(
                eq(pacaAgentTaskLeases.taskId, input.command.taskId),
                eq(pacaAgentTaskLeases.status, "active"),
              ),
            )
            .limit(1);
          if (active) return agentTaskLeaseErrorCodes.leaseConflict;

          const [created] = await transaction
            .insert(pacaAgentTaskLeases)
            .values({
              organizationId: input.command.organizationId,
              projectId: input.command.projectId,
              taskId: input.command.taskId,
              agentId: input.actor.agentId,
              hostId: input.actor.hostId,
              harnessKind: input.command.harness.kind,
              harnessVersion: input.command.harness.version ?? null,
              harnessInstanceId: input.command.harness.instanceId ?? null,
              status: "active",
              version: 1,
              lastCheckpointSequence: 0,
              leaseExpiresAt: renewedExpiry(input, input.command.leaseDurationMs),
              claimedAt: input.now,
              createdAt: input.now,
              updatedAt: input.now,
            })
            .returning();
          if (!created) throw new Error("AGENT_TASK_LEASE_CREATE_FAILED");
          await transaction
            .insert(pacaAgentTaskLeaseEvents)
            .values(eventValues(created.id, input.command, fingerprint));
          return { duplicate: false, lease: publicLease(created) };
        }

        const [current] = await transaction
          .select()
          .from(pacaAgentTaskLeases)
          .where(eq(pacaAgentTaskLeases.id, input.command.leaseId))
          .limit(1)
          .for("update");
        if (!current) return agentTaskLeaseErrorCodes.leaseNotFound;

        // The lease row serializes renew/checkpoint/terminal commands. Repeat
        // the request lookup after locking so concurrent retries stay idempotent.
        const duplicateAfterLeaseLock = await findDuplicate();
        if (duplicateAfterLeaseLock) return duplicateAfterLeaseLock;

        if (current.agentId !== input.actor.agentId || current.hostId !== input.actor.hostId) {
          return agentTaskLeaseErrorCodes.leaseOwnerMismatch;
        }
        if (
          current.organizationId !== input.command.organizationId ||
          current.projectId !== input.command.projectId ||
          current.taskId !== input.command.taskId
        ) {
          return agentTaskLeaseErrorCodes.leaseScopeMismatch;
        }
        if (current.status !== "active") return agentTaskLeaseErrorCodes.leaseTerminal;
        if (current.leaseExpiresAt.getTime() <= input.now.getTime()) {
          await transaction
            .update(pacaAgentTaskLeases)
            .set({
              status: "expired",
              version: sql`${pacaAgentTaskLeases.version} + 1`,
              finishedAt: input.now,
              updatedAt: input.now,
            })
            .where(eq(pacaAgentTaskLeases.id, current.id));
          return agentTaskLeaseErrorCodes.leaseExpired;
        }

        if (
          input.command.action === "checkpoint" &&
          input.command.sequence !== current.lastCheckpointSequence + 1
        ) {
          return agentTaskLeaseErrorCodes.checkpointSequenceInvalid;
        }

        const version = current.version + 1;
        const terminalStatus =
          input.command.action === "complete"
            ? "completed"
            : input.command.action === "fail"
              ? "failed"
              : input.command.action === "cancel_ack"
                ? "cancelled"
                : null;
        const [updated] = await transaction
          .update(pacaAgentTaskLeases)
          .set({
            version,
            updatedAt: input.now,
            ...(input.command.action === "renew"
              ? { leaseExpiresAt: renewedExpiry(input, input.command.leaseDurationMs) }
              : {}),
            ...(input.command.action === "checkpoint"
              ? { lastCheckpointSequence: input.command.sequence }
              : {}),
            ...(terminalStatus
              ? {
                  status: terminalStatus,
                  finishedAt: input.now,
                  errorCode: input.command.action === "fail" ? input.command.errorCode : null,
                  resultSummary:
                    input.command.action === "complete" || input.command.action === "fail"
                      ? (input.command.summary ?? null)
                      : input.command.action === "cancel_ack"
                        ? (input.command.summary ?? null)
                        : null,
                }
              : {}),
          })
          .where(eq(pacaAgentTaskLeases.id, current.id))
          .returning();
        if (!updated) throw new Error("AGENT_TASK_LEASE_UPDATE_FAILED");
        await transaction
          .insert(pacaAgentTaskLeaseEvents)
          .values(eventValues(current.id, input.command, fingerprint));
        return { duplicate: false, lease: publicLease(updated) };
      },
    );

    if (typeof outcome === "string") throw new AgentTaskLeaseError(outcome);
    return outcome;
  }
}
