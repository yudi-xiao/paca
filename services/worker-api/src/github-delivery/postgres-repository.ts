import { and, eq, isNull, sql } from "drizzle-orm";
import type { PacaDatabase } from "../database";
import {
  pacaAgentTaskLeases,
  pacaGithubDeliveries,
  pacaGithubDeliveryAudits,
  pacaGithubRepositories,
  pacaProjects,
  pacaTasks,
} from "../db/schema";
import {
  DeliveryWorkflowError,
  type DeliveryWrite,
  type GitHubDeliveryRepository,
  type RepositoryBinding,
  type RepositoryBindingInput,
  requireFreshDeliveryEvidence,
  type TaskDelivery,
} from "./service";

type Transaction = Parameters<Parameters<PacaDatabase["transaction"]>[0]>[0];
type DeliveryRow = typeof pacaGithubDeliveries.$inferSelect;
function deliveryRecord(row: DeliveryRow): TaskDelivery {
  const { pullNumber, headSha, ...rest } = row;
  return { ...rest, reference: { pullNumber, headSha } };
}
function conflict(code: ConstructorParameters<typeof DeliveryWorkflowError>[0]): never {
  throw new DeliveryWorkflowError(code);
}
async function projectLock(transaction: Transaction, projectId: string, exclusive: boolean) {
  const query = transaction
    .select({ id: pacaProjects.id })
    .from(pacaProjects)
    .where(and(eq(pacaProjects.id, projectId), eq(pacaProjects.status, "active")))
    .limit(1);
  const [project] = await query.for(exclusive ? "update" : "share");
  if (!project) conflict("DELIVERY_SCOPE_MISMATCH");
}
async function duplicate(transaction: Transaction, requestId: string, fingerprint: string) {
  const [event] = await transaction
    .select()
    .from(pacaGithubDeliveryAudits)
    .where(eq(pacaGithubDeliveryAudits.requestId, requestId))
    .limit(1);
  if (!event) return false;
  if (event.fingerprint !== fingerprint) conflict("DELIVERY_IDEMPOTENCY_CONFLICT");
  return true;
}
function uniqueConflict(error: unknown): never {
  let cause = error;
  for (let i = 0; i < 3 && cause && typeof cause === "object"; i++) {
    if ("code" in cause && cause.code === "23505") conflict("DELIVERY_IDEMPOTENCY_CONFLICT");
    cause = "cause" in cause ? cause.cause : null;
  }
  throw error;
}

/** PostgreSQL owns policy revisions, task/run association, decisions and audit.
 * Lock order is project -> repository -> task -> delivery. Remote I/O is never
 * performed while those locks are held. */
export class PostgresGitHubDeliveryRepository implements GitHubDeliveryRepository {
  constructor(private readonly database: PacaDatabase) {}
  async binding(projectId: string): Promise<RepositoryBinding | null> {
    const [row] = await this.database
      .select({ binding: pacaGithubRepositories })
      .from(pacaGithubRepositories)
      .innerJoin(
        pacaProjects,
        and(
          eq(pacaProjects.id, pacaGithubRepositories.projectId),
          eq(pacaProjects.status, "active"),
        ),
      )
      .where(eq(pacaGithubRepositories.projectId, projectId))
      .limit(1);
    return row?.binding ?? null;
  }
  async delivery(projectId: string, taskId: string): Promise<TaskDelivery | null> {
    const [row] = await this.database
      .select({ delivery: pacaGithubDeliveries })
      .from(pacaGithubDeliveries)
      .innerJoin(
        pacaTasks,
        and(
          eq(pacaTasks.id, pacaGithubDeliveries.taskId),
          eq(pacaTasks.projectId, pacaGithubDeliveries.projectId),
          isNull(pacaTasks.deletedAt),
        ),
      )
      .innerJoin(
        pacaProjects,
        and(eq(pacaProjects.id, pacaGithubDeliveries.projectId), eq(pacaProjects.status, "active")),
      )
      .where(
        and(eq(pacaGithubDeliveries.projectId, projectId), eq(pacaGithubDeliveries.taskId, taskId)),
      )
      .limit(1);
    return row ? deliveryRecord(row.delivery) : null;
  }
  async configure(
    projectId: string,
    actorId: string,
    input: RepositoryBindingInput,
    now: Date,
  ): Promise<RepositoryBinding> {
    const fingerprint = JSON.stringify([
      "configure",
      projectId,
      actorId,
      input.expectedVersion,
      input.repositoryId,
      input.installationId,
      input.policy,
    ]);
    try {
      return await this.database.transaction(async (transaction) => {
        await projectLock(transaction, projectId, true);
        const [current] = await transaction
          .select()
          .from(pacaGithubRepositories)
          .where(eq(pacaGithubRepositories.projectId, projectId))
          .limit(1)
          .for("update");
        if (await duplicate(transaction, input.requestId, fingerprint)) {
          if (!current) conflict("DELIVERY_REPOSITORY_NOT_CONFIGURED");
          return current;
        }
        if ((current?.version ?? 0) !== input.expectedVersion)
          conflict("DELIVERY_VERSION_CONFLICT");
        const values = {
          projectId,
          repositoryId: input.repositoryId,
          installationId: input.installationId,
          policy: input.policy,
          version: (current?.version ?? 0) + 1,
          status: "active" as const,
          updatedAt: now,
        };
        const [saved] = await transaction
          .insert(pacaGithubRepositories)
          .values(values)
          .onConflictDoUpdate({ target: pacaGithubRepositories.projectId, set: values })
          .returning();
        if (!saved) conflict("DELIVERY_REPOSITORY_NOT_CONFIGURED");
        await transaction
          .update(pacaGithubDeliveries)
          .set({
            state: "stale",
            acceptedBy: null,
            acceptedAt: null,
            requestedChangesBy: null,
            requestedChangesAt: null,
            reviewNote: "",
            version: sql`${pacaGithubDeliveries.version} + 1`,
            updatedAt: now,
          })
          .where(eq(pacaGithubDeliveries.projectId, projectId));
        await transaction.insert(pacaGithubDeliveryAudits).values({
          projectId,
          actorId,
          requestId: input.requestId,
          fingerprint,
          action: "configure",
          detail: {
            repositoryId: saved.repositoryId,
            installationId: saved.installationId,
            policyVersion: saved.version,
            policy: saved.policy,
          },
        });
        return saved;
      });
    } catch (error) {
      return uniqueConflict(error);
    }
  }
  async write(input: DeliveryWrite): Promise<TaskDelivery> {
    try {
      return await this.database.transaction(async (transaction) => {
        await projectLock(transaction, input.projectId, false);
        const [binding] = await transaction
          .select()
          .from(pacaGithubRepositories)
          .where(eq(pacaGithubRepositories.projectId, input.projectId))
          .limit(1)
          .for("share");
        if (!binding || binding.status !== "active") conflict("DELIVERY_REPOSITORY_NOT_CONFIGURED");
        if (
          binding.version !== input.binding.version ||
          binding.repositoryId !== input.binding.repositoryId ||
          binding.installationId !== input.binding.installationId
        )
          conflict("DELIVERY_VERSION_CONFLICT");
        if (input.action !== "request_changes")
          requireFreshDeliveryEvidence(binding, input.reference, input.evidence, input.now);
        const [task] = await transaction
          .select({ id: pacaTasks.id })
          .from(pacaTasks)
          .where(
            and(
              eq(pacaTasks.id, input.taskId),
              eq(pacaTasks.projectId, input.projectId),
              isNull(pacaTasks.deletedAt),
            ),
          )
          .limit(1)
          .for("update");
        if (!task) conflict("DELIVERY_SCOPE_MISMATCH");
        const [lease] = await transaction
          .select()
          .from(pacaAgentTaskLeases)
          .where(eq(pacaAgentTaskLeases.id, input.leaseId))
          .limit(1)
          .for("share");
        if (!lease || lease.projectId !== input.projectId || lease.taskId !== input.taskId)
          conflict("DELIVERY_SCOPE_MISMATCH");
        if (lease.status !== "completed") conflict("DELIVERY_RUN_NOT_COMPLETED");
        const [current] = await transaction
          .select()
          .from(pacaGithubDeliveries)
          .where(
            and(
              eq(pacaGithubDeliveries.projectId, input.projectId),
              eq(pacaGithubDeliveries.taskId, input.taskId),
            ),
          )
          .limit(1)
          .for("update");
        if (await duplicate(transaction, input.requestId, input.fingerprint)) {
          if (!current) conflict("DELIVERY_NOT_FOUND");
          return deliveryRecord(current);
        }
        if ((current?.version ?? 0) !== input.expectedVersion)
          conflict("DELIVERY_VERSION_CONFLICT");
        if (
          input.action !== "submit" &&
          (!current ||
            current.leaseId !== input.leaseId ||
            current.repositoryId !== binding.repositoryId ||
            current.pullNumber !== input.reference.pullNumber ||
            current.headSha !== input.reference.headSha)
        )
          conflict("DELIVERY_SCOPE_MISMATCH");
        const eligible = input.evidence.state === "awaiting_acceptance";
        const preserveAcceptance =
          input.action === "refresh" && current?.state === "accepted" && eligible;
        const accepted = (input.action === "accept" && eligible) || preserveAcceptance;
        const preserveChanges =
          !accepted &&
          current?.requestedChangesBy &&
          current.headSha === input.reference.headSha &&
          current.pullNumber === input.reference.pullNumber &&
          current.repositoryId === binding.repositoryId;
        const changesRequested = input.action === "request_changes" || preserveChanges;
        const state = accepted
          ? ("accepted" as const)
          : changesRequested
            ? ("needs_changes" as const)
            : input.evidence.state;
        const values = {
          projectId: input.projectId,
          taskId: input.taskId,
          leaseId: input.leaseId,
          repositoryId: binding.repositoryId,
          policyVersion: binding.version,
          version: (current?.version ?? 0) + 1,
          pullNumber: input.reference.pullNumber,
          headSha: input.reference.headSha,
          state,
          evidence: input.evidence,
          acceptedBy: accepted ? (preserveAcceptance ? current.acceptedBy : input.actorId) : null,
          acceptedAt: accepted ? (preserveAcceptance ? current.acceptedAt : input.now) : null,
          requestedChangesBy: changesRequested
            ? input.action === "request_changes"
              ? input.actorId
              : (current?.requestedChangesBy ?? null)
            : null,
          requestedChangesAt: changesRequested
            ? input.action === "request_changes"
              ? input.now
              : (current?.requestedChangesAt ?? null)
            : null,
          reviewNote:
            input.action === "accept" || input.action === "request_changes"
              ? input.note
              : preserveChanges || preserveAcceptance
                ? (current?.reviewNote ?? "")
                : "",
          updatedAt: input.now,
        };
        const [saved] = current
          ? await transaction
              .update(pacaGithubDeliveries)
              .set(values)
              .where(eq(pacaGithubDeliveries.id, current.id))
              .returning()
          : await transaction.insert(pacaGithubDeliveries).values(values).returning();
        if (!saved) conflict("DELIVERY_NOT_FOUND");
        await transaction.insert(pacaGithubDeliveryAudits).values({
          projectId: input.projectId,
          taskId: input.taskId,
          actorId: input.actorId,
          action: input.action,
          requestId: input.requestId,
          fingerprint: input.fingerprint,
          detail: {
            deliveryId: saved.id,
            leaseId: saved.leaseId,
            repositoryId: saved.repositoryId,
            policyVersion: saved.policyVersion,
            pullNumber: saved.pullNumber,
            headSha: saved.headSha,
            version: saved.version,
            state: saved.state,
            decisionApplied: input.action !== "accept" || accepted,
            evidence: saved.evidence,
            note: input.note,
          },
        });
        // Task status is intentionally untouched: delivery acceptance is a
        // separate user decision, not a generic Agent field update.
        return deliveryRecord(saved);
      });
    } catch (error) {
      return uniqueConflict(error);
    }
  }
}
