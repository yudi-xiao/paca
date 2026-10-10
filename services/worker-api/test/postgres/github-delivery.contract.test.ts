import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import * as schema from "../../src/db/schema";
import {
  agent,
  agentHost,
  organization,
  pacaAgentTaskLeases,
  pacaGithubDeliveryAudits,
  pacaGithubWebhookReceipts,
  pacaProjects,
  pacaTasks,
  user,
} from "../../src/db/schema";
import {
  GitHubDeliveryError,
  type GitHubDeliveryEvidence,
  type GitHubDeliveryPolicy,
} from "../../src/github-delivery/evidence";
import { PostgresGitHubDeliveryRepository } from "../../src/github-delivery/postgres-repository";
import { DeliveryWorkflowError, GitHubDeliveryService } from "../../src/github-delivery/service";
import { captureGitHubWebhook } from "../../src/github-delivery/webhook-runtime";

const databaseURL = process.env.PACA_TEST_DATABASE_URL?.trim();
if (process.env.PACA_REQUIRE_POSTGRES_CONTRACTS === "true" && !databaseURL)
  throw Error("PACA_TEST_DATABASE_URL_REQUIRED");
const headSha = "a".repeat(40);
const policy: GitHubDeliveryPolicy = {
  owner: "paca-test",
  repository: "delivery",
  requiredChecks: [{ name: "Tests", appId: 123 }],
  maxCheckAgeSeconds: 86400,
  reviewerIds: [2],
  requiredApprovals: 1,
};
function evidence(): GitHubDeliveryEvidence {
  return {
    repository: "paca-test/delivery",
    pullNumber: 42,
    headSha,
    pullUrl: "https://github.com/paca-test/delivery/pull/42",
    observedAt: new Date().toISOString(),
    state: "awaiting_acceptance",
    reasons: [],
    checks: [{ name: "Tests", appId: 123, runId: 10, state: "passed" }],
    approvalCount: 1,
  };
}
async function fixture(
  run: (context: {
    database: ReturnType<typeof drizzle<typeof schema>>;
    repository: PostgresGitHubDeliveryRepository;
    service: GitHubDeliveryService;
    source: {
      verifyRepository: ReturnType<typeof vi.fn<() => Promise<void>>>;
      inspect: ReturnType<typeof vi.fn<() => Promise<GitHubDeliveryEvidence>>>;
    };
    authorize: ReturnType<
      typeof vi.fn<(projectId: string, actorId: string, configure: boolean) => Promise<void>>
    >;
    actorId: string;
    projectId: string;
    taskId: string;
    otherTaskId: string;
    foreignTaskId: string;
    leaseId: string;
    activeLeaseId: string;
    foreignLeaseId: string;
  }) => Promise<void>,
) {
  const pool = new Pool({ connectionString: databaseURL, max: 4 });
  const database = drizzle(pool, { schema });
  const actorId = crypto.randomUUID();
  const organizationId = `github-${crypto.randomUUID()}`;
  const hostId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const now = new Date();
  try {
    await database
      .insert(user)
      .values({ id: actorId, name: "Delivery tester", email: `${actorId}@example.test` });
    await database
      .insert(organization)
      .values({ id: organizationId, name: "Delivery", slug: organizationId, createdAt: now });
    await database
      .insert(agentHost)
      .values({ id: hostId, userId: actorId, createdAt: now, updatedAt: now });
    await database.insert(agent).values({
      id: agentId,
      hostId,
      userId: actorId,
      name: "Delivery Agent",
      publicKey: "test-only",
      createdAt: now,
      updatedAt: now,
    });
    const [project, foreign] = await database
      .insert(pacaProjects)
      .values([
        {
          organizationId,
          createdBy: actorId,
          name: "Delivery",
          slug: `delivery-${organizationId}`,
        },
        { organizationId, createdBy: actorId, name: "Foreign", slug: `foreign-${organizationId}` },
      ])
      .returning();
    if (!project || !foreign) throw Error("PROJECT_FIXTURE_MISSING");
    const [task, otherTask, foreignTask] = await database
      .insert(pacaTasks)
      .values([
        { projectId: project.id, taskNumber: 1, title: "Deliver" },
        { projectId: project.id, taskNumber: 2, title: "Other" },
        { projectId: foreign.id, taskNumber: 1, title: "Foreign" },
      ])
      .returning();
    if (!task || !otherTask || !foreignTask) throw Error("TASK_FIXTURE_MISSING");
    const [lease, activeLease, foreignLease] = await database
      .insert(pacaAgentTaskLeases)
      .values([
        {
          projectId: project.id,
          taskId: task.id,
          organizationId,
          agentId,
          hostId,
          harnessKind: "codex",
          status: "completed" as const,
          finishedAt: now,
          leaseExpiresAt: new Date(now.getTime() + 60000),
        },
        {
          projectId: project.id,
          taskId: otherTask.id,
          organizationId,
          agentId,
          hostId,
          harnessKind: "codex",
          status: "active" as const,
          leaseExpiresAt: new Date(now.getTime() + 60000),
        },
        {
          projectId: foreign.id,
          taskId: foreignTask.id,
          organizationId,
          agentId,
          hostId,
          harnessKind: "codex",
          status: "completed" as const,
          finishedAt: now,
          leaseExpiresAt: new Date(now.getTime() + 60000),
        },
      ])
      .returning();
    if (!lease || !activeLease || !foreignLease) throw Error("LEASE_FIXTURE_MISSING");
    const repository = new PostgresGitHubDeliveryRepository(database);
    const source = {
      verifyRepository: vi.fn(async () => {}),
      inspect: vi.fn(async () => evidence()),
    };
    const authorize = vi.fn(
      async (_projectId: string, _actorId: string, _configure: boolean) => {},
    );
    const service = new GitHubDeliveryService(repository, source, authorize);
    await service.configure(project.id, actorId, {
      requestId: crypto.randomUUID(),
      expectedVersion: 0,
      repositoryId: 100,
      installationId: 200,
      policy,
    });
    await run({
      database,
      repository,
      service,
      source,
      authorize,
      actorId,
      projectId: project.id,
      taskId: task.id,
      otherTaskId: otherTask.id,
      foreignTaskId: foreignTask.id,
      leaseId: lease.id,
      activeLeaseId: activeLease.id,
      foreignLeaseId: foreignLease.id,
    });
  } finally {
    await database.delete(organization).where(eq(organization.id, organizationId));
    await database.delete(user).where(eq(user.id, actorId));
    await pool.end();
  }
}
function submit(leaseId: string, expectedVersion = 0) {
  return { requestId: crypto.randomUUID(), expectedVersion, leaseId, pullNumber: 42, headSha };
}
describe.skipIf(!databaseURL)("PostgreSQL GitHub delivery acceptance", () => {
  it("paginates completed runs with stable ties, excludes other tasks and hides archived work", async () =>
    fixture(
      async ({
        database,
        repository,
        projectId,
        taskId,
        otherTaskId,
        leaseId,
        foreignLeaseId,
        activeLeaseId,
      }) => {
        const [original] = await database
          .select()
          .from(pacaAgentTaskLeases)
          .where(eq(pacaAgentTaskLeases.id, leaseId));
        if (!original) throw Error("LEASE_FIXTURE_MISSING");
        await database
          .insert(pacaAgentTaskLeases)
          .values(Array.from({ length: 24 }, () => ({ ...original, id: crypto.randomUUID() })));
        await database.insert(pacaAgentTaskLeases).values({
          ...original,
          id: crypto.randomUUID(),
          status: "failed",
          errorCode: "EXECUTION_FAILED",
        });
        const first = await repository.completedRuns(projectId, taskId);
        expect(first.items).toHaveLength(20);
        expect(first.nextCursor).toBe(first.items.at(-1)?.leaseId);
        const second = await repository.completedRuns(
          projectId,
          taskId,
          first.nextCursor ?? undefined,
        );
        expect(second.items).toHaveLength(5);
        expect(second.nextCursor).toBeNull();
        const all = [...first.items, ...second.items];
        expect(new Set(all.map((run) => run.leaseId)).size).toBe(25);
        expect(all.map((run) => run.leaseId)).toEqual(
          all
            .map((run) => run.leaseId)
            .sort()
            .reverse(),
        );
        expect(Object.keys(all[0] ?? {}).sort()).toEqual(["finishedAt", "harnessKind", "leaseId"]);
        expect((await repository.completedRuns(projectId, otherTaskId)).items).toEqual([]);
        for (const cursor of [foreignLeaseId, activeLeaseId])
          await expect(repository.completedRuns(projectId, taskId, cursor)).rejects.toMatchObject({
            code: "DELIVERY_INPUT_INVALID",
          });
        await database
          .update(pacaTasks)
          .set({ deletedAt: new Date() })
          .where(eq(pacaTasks.id, taskId));
        expect((await repository.completedRuns(projectId, taskId)).items).toEqual([]);
        await expect(repository.completedRuns(projectId, taskId, leaseId)).rejects.toMatchObject({
          code: "DELIVERY_INPUT_INVALID",
        });
      },
    ));
  it("invalidates accepted evidence atomically, deduplicates concurrent delivery and rejects a reused ID", async () =>
    fixture(async ({ database, service, repository, projectId, taskId, actorId, leaseId }) => {
      await service.submit(projectId, taskId, actorId, submit(leaseId));
      await service.decide(projectId, taskId, actorId, {
        requestId: crypto.randomUUID(),
        expectedVersion: 1,
        decision: "accept",
      });
      const event = {
        deliveryId: crypto.randomUUID(),
        digest: "a".repeat(64),
        event: "check_run",
        installationId: 200,
        repositoryId: 100,
        pullNumber: null,
        headSha,
        revoke: false,
        removedRepositoryIds: [],
      };
      try {
        const results = await Promise.all([
          captureGitHubWebhook(database, event),
          captureGitHubWebhook(database, event),
        ]);
        expect(results.map((result) => result.duplicate).sort()).toEqual([false, true]);
        expect(results.map((result) => result.affected)).toEqual([1, 1]);
        expect(await repository.delivery(projectId, taskId)).toMatchObject({
          state: "stale",
          version: 3,
          acceptedBy: null,
        });
        await expect(
          captureGitHubWebhook(database, { ...event, digest: "b".repeat(64) }),
        ).rejects.toMatchObject({ code: "GITHUB_WEBHOOK_IDEMPOTENCY_CONFLICT" });
        await expect(
          service.decide(projectId, taskId, actorId, {
            requestId: crypto.randomUUID(),
            expectedVersion: 2,
            decision: "accept",
          }),
        ).rejects.toMatchObject({ code: "DELIVERY_VERSION_CONFLICT" });
      } finally {
        await database
          .delete(pacaGithubWebhookReceipts)
          .where(eq(pacaGithubWebhookReceipts.deliveryId, event.deliveryId));
      }
    }));
  it("revokes the precise installation binding and retains human rejection across signed invalidations", async () =>
    fixture(async ({ database, service, repository, projectId, taskId, actorId, leaseId }) => {
      await service.submit(projectId, taskId, actorId, submit(leaseId));
      await service.decide(projectId, taskId, actorId, {
        requestId: crypto.randomUUID(),
        expectedVersion: 1,
        decision: "request_changes",
        note: "Fix UX",
      });
      const event = {
        deliveryId: crypto.randomUUID(),
        digest: "a".repeat(64),
        event: "installation_repositories",
        installationId: 200,
        repositoryId: null,
        pullNumber: null,
        headSha: null,
        revoke: true,
        removedRepositoryIds: [100],
      };
      const wrong = { ...event, deliveryId: crypto.randomUUID(), installationId: 201 };
      try {
        expect(await captureGitHubWebhook(database, wrong)).toMatchObject({ affected: 0 });
        expect((await repository.binding(projectId))?.status).toBe("active");
        expect(await captureGitHubWebhook(database, event)).toMatchObject({ affected: 1 });
        expect(await repository.binding(projectId)).toMatchObject({
          status: "revoked",
          version: 2,
        });
        expect(await repository.delivery(projectId, taskId)).toMatchObject({
          state: "needs_changes",
          requestedChangesBy: actorId,
          reviewNote: "Fix UX",
        });
        await expect(
          service.refresh(projectId, taskId, actorId, {
            requestId: crypto.randomUUID(),
            expectedVersion: 3,
          }),
        ).rejects.toMatchObject({ code: "DELIVERY_REPOSITORY_NOT_CONFIGURED" });
      } finally {
        await database
          .delete(pacaGithubWebhookReceipts)
          .where(
            inArray(pacaGithubWebhookReceipts.deliveryId, [event.deliveryId, wrong.deliveryId]),
          );
      }
    }));
  it("does not reuse a human rejection on a different PR with the same commit", async () =>
    fixture(async ({ service, source, projectId, taskId, actorId, leaseId }) => {
      await service.submit(projectId, taskId, actorId, submit(leaseId));
      await service.decide(projectId, taskId, actorId, {
        requestId: crypto.randomUUID(),
        expectedVersion: 1,
        decision: "request_changes",
      });
      source.inspect.mockImplementation(async () => ({
        ...evidence(),
        pullNumber: 43,
        pullUrl: "https://github.com/paca-test/delivery/pull/43",
      }));
      expect(
        await service.submit(projectId, taskId, actorId, { ...submit(leaseId, 2), pullNumber: 43 }),
      ).toMatchObject({ state: "awaiting_acceptance", requestedChangesBy: null });
    }));
  it("binds a completed task run, leaves it awaiting a trusted user's fresh decision, and keeps task status unchanged", async () =>
    fixture(async (context) => {
      const { service, source, repository, database, projectId, taskId, actorId, leaseId } =
        context;
      const submitted = await service.submit(projectId, taskId, actorId, submit(leaseId));
      expect(submitted).toMatchObject({
        state: "awaiting_acceptance",
        acceptedBy: null,
        version: 1,
        leaseId,
      });
      expect(source.inspect).toHaveBeenLastCalledWith(
        expect.objectContaining({ projectId, repositoryId: 100 }),
        { pullNumber: 42, headSha },
      );
      const accepted = await service.decide(projectId, taskId, actorId, {
        requestId: crypto.randomUUID(),
        expectedVersion: 1,
        decision: "accept",
        note: "Verified feature",
      });
      expect(accepted).toMatchObject({
        state: "accepted",
        acceptedBy: actorId,
        reviewNote: "Verified feature",
        version: 2,
      });
      expect(source.inspect).toHaveBeenCalledTimes(2);
      expect((await repository.delivery(projectId, taskId))?.acceptedAt).toBeInstanceOf(Date);
      const [task] = await database
        .select({ status: pacaTasks.statusId })
        .from(pacaTasks)
        .where(eq(pacaTasks.id, taskId));
      expect(task?.status).toBeNull();
      const audit = await database
        .select()
        .from(pacaGithubDeliveryAudits)
        .where(
          and(
            eq(pacaGithubDeliveryAudits.projectId, projectId),
            eq(pacaGithubDeliveryAudits.action, "accept"),
          ),
        );
      expect(audit).toHaveLength(1);
      expect(audit[0]?.actorId).toBe(actorId);
      expect(audit[0]?.detail).toMatchObject({ headSha, state: "accepted", leaseId });
    }));
  it("rejects active leases, cross-project runs, cross-task runs and deleted tasks", async () =>
    fixture(
      async ({
        service,
        database,
        projectId,
        taskId,
        actorId,
        leaseId,
        otherTaskId,
        activeLeaseId,
        foreignLeaseId,
      }) => {
        await expect(
          service.submit(projectId, otherTaskId, actorId, submit(activeLeaseId)),
        ).rejects.toMatchObject({ code: "DELIVERY_RUN_NOT_COMPLETED" });
        for (const id of [activeLeaseId, foreignLeaseId])
          await expect(
            service.submit(projectId, taskId, actorId, submit(id)),
          ).rejects.toMatchObject({ code: "DELIVERY_SCOPE_MISMATCH" });
        await database
          .update(pacaTasks)
          .set({ deletedAt: new Date() })
          .where(eq(pacaTasks.id, taskId));
        await expect(
          service.submit(projectId, taskId, actorId, submit(leaseId)),
        ).rejects.toMatchObject({ code: "DELIVERY_SCOPE_MISMATCH" });
      },
    ));
  it("serializes concurrent first submissions and identical acceptance retries without duplicate audit", async () =>
    fixture(async ({ service, database, projectId, taskId, actorId, leaseId }) => {
      const submission = submit(leaseId);
      const first = await Promise.all([
        service.submit(projectId, taskId, actorId, submission),
        service.submit(projectId, taskId, actorId, submission),
      ]);
      expect(first.map((item) => item.version)).toEqual([1, 1]);
      const decision = { requestId: crypto.randomUUID(), expectedVersion: 1, decision: "accept" };
      const accepted = await Promise.all([
        service.decide(projectId, taskId, actorId, decision),
        service.decide(projectId, taskId, actorId, decision),
      ]);
      expect(accepted.map((item) => item.version)).toEqual([2, 2]);
      const audit = await database
        .select()
        .from(pacaGithubDeliveryAudits)
        .where(eq(pacaGithubDeliveryAudits.projectId, projectId));
      expect(audit.map((item) => item.action).sort()).toEqual(["accept", "configure", "submit"]);
      await expect(
        service.decide(projectId, taskId, actorId, { ...decision, note: "Changed request" }),
      ).rejects.toMatchObject({ code: "DELIVERY_IDEMPOTENCY_CONFLICT" });
    }));
  it("retains human requested changes across green CI refreshes and permits rejection while GitHub is unavailable", async () =>
    fixture(async ({ service, source, projectId, taskId, actorId, leaseId }) => {
      await service.submit(projectId, taskId, actorId, submit(leaseId));
      source.inspect.mockRejectedValueOnce(new GitHubDeliveryError("GITHUB_DELIVERY_UNAVAILABLE"));
      const rejected = await service.decide(projectId, taskId, actorId, {
        requestId: crypto.randomUUID(),
        expectedVersion: 1,
        decision: "request_changes",
        note: "Fix the UX",
      });
      expect(rejected).toMatchObject({
        state: "needs_changes",
        requestedChangesBy: actorId,
        reviewNote: "Fix the UX",
      });
      expect(source.inspect).toHaveBeenCalledTimes(1);
      source.inspect.mockReset().mockImplementation(async () => evidence());
      const refreshed = await service.refresh(projectId, taskId, actorId, {
        requestId: crypto.randomUUID(),
        expectedVersion: rejected.version,
      });
      expect(refreshed).toMatchObject({
        state: "needs_changes",
        requestedChangesBy: actorId,
        reviewNote: "Fix the UX",
      });
    }));
  it.each([
    "needs_changes",
    "waiting",
    "stale",
    "unavailable",
  ] as const)("rejects human acceptance when refreshed evidence is %s and persists the failure", async (state) =>
    fixture(async ({ service, source, repository, projectId, taskId, actorId, leaseId }) => {
      await service.submit(projectId, taskId, actorId, submit(leaseId));
      source.inspect.mockImplementation(async () => ({
        ...evidence(),
        state,
        reasons: ["NOT_READY"],
      }));
      await expect(
        service.decide(projectId, taskId, actorId, {
          requestId: crypto.randomUUID(),
          expectedVersion: 1,
          decision: "accept",
        }),
      ).rejects.toMatchObject({ code: "DELIVERY_EVIDENCE_NOT_READY" });
      expect(await repository.delivery(projectId, taskId)).toMatchObject({
        state,
        acceptedBy: null,
      });
    }));
  it("invalidates accepted evidence after a failed check, unavailable GitHub, and policy changes", async () =>
    fixture(async ({ service, source, repository, projectId, taskId, actorId, leaseId }) => {
      await service.submit(projectId, taskId, actorId, submit(leaseId));
      await service.decide(projectId, taskId, actorId, {
        requestId: crypto.randomUUID(),
        expectedVersion: 1,
        decision: "accept",
      });
      source.inspect.mockRejectedValueOnce(new GitHubDeliveryError("GITHUB_DELIVERY_UNAVAILABLE"));
      const unavailable = await service.refresh(projectId, taskId, actorId, {
        requestId: crypto.randomUUID(),
        expectedVersion: 2,
      });
      expect(unavailable).toMatchObject({ state: "unavailable", acceptedBy: null });
      const config = {
        requestId: crypto.randomUUID(),
        expectedVersion: 1,
        repositoryId: 100,
        installationId: 200,
        policy: { ...policy, requiredApprovals: 0 },
      };
      await service.configure(projectId, actorId, config);
      expect(await repository.delivery(projectId, taskId)).toMatchObject({
        state: "stale",
        acceptedBy: null,
        version: 4,
      });
      await expect(
        service.refresh(projectId, taskId, actorId, {
          requestId: crypto.randomUUID(),
          expectedVersion: 3,
        }),
      ).rejects.toMatchObject({ code: "DELIVERY_VERSION_CONFLICT" });
    }));
  it("rejects a stale policy snapshot changed during GitHub collection", async () =>
    fixture(async ({ service, source, repository, projectId, taskId, actorId, leaseId }) => {
      source.inspect.mockImplementationOnce(async () => {
        await service.configure(projectId, actorId, {
          requestId: crypto.randomUUID(),
          expectedVersion: 1,
          repositoryId: 100,
          installationId: 200,
          policy,
        });
        return evidence();
      });
      await expect(
        service.submit(projectId, taskId, actorId, submit(leaseId)),
      ).rejects.toMatchObject({ code: "DELIVERY_VERSION_CONFLICT" });
      expect(await repository.delivery(projectId, taskId)).toBeNull();
    }));
  it("rechecks permission after external I/O and never accepts client-supplied actor or evidence", async () =>
    fixture(
      async ({ service, source, authorize, repository, projectId, taskId, actorId, leaseId }) => {
        for (const extra of [
          { actorId: "forged" },
          { evidence: evidence() },
          { acceptedBy: actorId },
        ])
          await expect(
            service.submit(projectId, taskId, actorId, { ...submit(leaseId), ...extra }),
          ).rejects.toMatchObject({ code: "DELIVERY_INPUT_INVALID" });
        source.inspect.mockImplementationOnce(async () => {
          authorize.mockRejectedValue(new DeliveryWorkflowError("DELIVERY_PERMISSION_DENIED"));
          return evidence();
        });
        await expect(
          service.submit(projectId, taskId, actorId, submit(leaseId)),
        ).rejects.toMatchObject({ code: "DELIVERY_PERMISSION_DENIED" });
        expect(await repository.delivery(projectId, taskId)).toBeNull();
      },
    ));
  it("rejects repository, PR, SHA and snapshot freshness mismatches before persistence", async () =>
    fixture(async ({ service, source, repository, projectId, taskId, actorId, leaseId }) => {
      for (const extra of [
        { repository: "foreign/repo" },
        { pullNumber: 43 },
        { headSha: "b".repeat(40) },
        { observedAt: new Date(Date.now() - 61_000).toISOString() },
      ]) {
        source.inspect.mockResolvedValueOnce({ ...evidence(), ...extra });
        await expect(
          service.submit(projectId, taskId, actorId, submit(leaseId)),
        ).rejects.toMatchObject({ code: "DELIVERY_SCOPE_MISMATCH" });
      }
      expect(await repository.delivery(projectId, taskId)).toBeNull();
    }));
});
