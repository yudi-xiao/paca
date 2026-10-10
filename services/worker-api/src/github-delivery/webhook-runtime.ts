import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import type { AppBindings } from "../bindings";
import { type PacaDatabase, withDatabase } from "../database";
import {
  pacaGithubDeliveries,
  pacaGithubRepositories,
  pacaGithubWebhookReceipts,
  pacaProjects,
} from "../db/schema";
import { GitHubWebhookError, type GitHubWebhookEvent, verifyGitHubWebhook } from "./webhook";

export async function captureGitHubWebhook(
  database: PacaDatabase,
  input: GitHubWebhookEvent,
  now = new Date(),
) {
  return database.transaction(async (transaction) => {
    const [inserted] = await transaction
      .insert(pacaGithubWebhookReceipts)
      .values({
        deliveryId: input.deliveryId,
        digest: input.digest,
        event: input.event,
        installationId: input.installationId,
        repositoryId: input.repositoryId,
        receivedAt: now,
      })
      .onConflictDoNothing()
      .returning({ deliveryId: pacaGithubWebhookReceipts.deliveryId });
    if (!inserted) {
      const [existing] = await transaction
        .select()
        .from(pacaGithubWebhookReceipts)
        .where(eq(pacaGithubWebhookReceipts.deliveryId, input.deliveryId));
      if (!existing || existing.digest !== input.digest)
        throw new GitHubWebhookError("GITHUB_WEBHOOK_IDEMPOTENCY_CONFLICT");
      return { duplicate: true, affected: existing.affected };
    }
    const scope = and(
      eq(pacaGithubRepositories.installationId, input.installationId),
      input.repositoryId ? eq(pacaGithubRepositories.repositoryId, input.repositoryId) : undefined,
      input.removedRepositoryIds.length
        ? inArray(pacaGithubRepositories.repositoryId, input.removedRepositoryIds)
        : undefined,
    );
    // Same deterministic project -> repository -> delivery order as user writes.
    // Receipt + invalidation commit together before returning a 2xx to GitHub.
    const projects = await transaction
      .select({ id: pacaProjects.id })
      .from(pacaProjects)
      .innerJoin(pacaGithubRepositories, eq(pacaGithubRepositories.projectId, pacaProjects.id))
      .where(scope)
      .orderBy(asc(pacaProjects.id))
      .limit(101)
      .for("update", { of: pacaProjects });
    if (projects.length > 100) throw Error("GITHUB_WEBHOOK_SCOPE_LIMIT");
    let affected = 0;
    for (const project of projects) {
      const [binding] = await transaction
        .select()
        .from(pacaGithubRepositories)
        .where(and(scope, eq(pacaGithubRepositories.projectId, project.id)))
        .for("update");
      if (!binding) continue;
      if (input.revoke)
        await transaction
          .update(pacaGithubRepositories)
          .set({
            status: "revoked",
            version: sql`${pacaGithubRepositories.version} + 1`,
            updatedAt: now,
          })
          .where(eq(pacaGithubRepositories.projectId, project.id));
      const result = await transaction
        .update(pacaGithubDeliveries)
        .set({
          state: sql`case when ${pacaGithubDeliveries.requestedChangesBy} is not null then 'needs_changes' else 'stale' end`,
          acceptedBy: null,
          acceptedAt: null,
          version: sql`${pacaGithubDeliveries.version} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(pacaGithubDeliveries.projectId, project.id),
            eq(pacaGithubDeliveries.repositoryId, binding.repositoryId),
            input.pullNumber ? eq(pacaGithubDeliveries.pullNumber, input.pullNumber) : undefined,
            input.headSha ? eq(pacaGithubDeliveries.headSha, input.headSha) : undefined,
          ),
        );
      affected += result.rowCount ?? 0;
    }
    await transaction
      .update(pacaGithubWebhookReceipts)
      .set({ affected })
      .where(eq(pacaGithubWebhookReceipts.deliveryId, input.deliveryId));
    return { duplicate: false, affected };
  });
}

export async function handleGitHubWebhook(request: Request, env: AppBindings): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  try {
    const event = await verifyGitHubWebhook(request, env.GITHUB_WEBHOOK_SECRET);
    if (!event) return Response.json({ status: "ignored" }, { headers });
    const result = await withDatabase(env, (database) => captureGitHubWebhook(database, event));
    return Response.json({ status: "received", ...result }, { headers });
  } catch (error) {
    const code = error instanceof GitHubWebhookError ? error.code : "GITHUB_WEBHOOK_UNAVAILABLE";
    const status =
      code === "GITHUB_WEBHOOK_SIGNATURE_INVALID"
        ? 401
        : code === "GITHUB_WEBHOOK_INPUT_INVALID"
          ? 400
          : code === "GITHUB_WEBHOOK_TOO_LARGE"
            ? 413
            : code === "GITHUB_WEBHOOK_IDEMPOTENCY_CONFLICT"
              ? 409
              : 503;
    return Response.json({ error: code }, { status, headers });
  }
}

export async function cleanGitHubWebhookReceipts(env: AppBindings, now: Date) {
  const cutoff = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  return withDatabase(env, async (database) => {
    const candidates = database
      .select({ id: pacaGithubWebhookReceipts.deliveryId })
      .from(pacaGithubWebhookReceipts)
      .where(lt(pacaGithubWebhookReceipts.receivedAt, cutoff))
      .orderBy(asc(pacaGithubWebhookReceipts.receivedAt))
      .limit(500);
    await database
      .delete(pacaGithubWebhookReceipts)
      .where(inArray(pacaGithubWebhookReceipts.deliveryId, candidates));
  });
}
