import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresAgentTaskLeaseRepository } from "../../src/agent-task/postgres-repository";
import type { AgentTaskLeaseCommand } from "../../src/agent-task/protocol";
import { AgentTaskLeaseService, agentTaskLeaseErrorCodes } from "../../src/agent-task/service";
import * as schema from "../../src/db/schema";
import {
  agent,
  agentHost,
  organization,
  pacaAgentTaskLeaseEvents,
  pacaProjects,
  pacaTasks,
  user,
} from "../../src/db/schema";

const databaseURL = process.env.PACA_TEST_DATABASE_URL?.trim();
if (process.env.PACA_REQUIRE_POSTGRES_CONTRACTS === "true" && !databaseURL)
  throw Error("PACA_TEST_DATABASE_URL_REQUIRED");
const now = new Date("2026-10-10T00:00:00Z");
const expiry = new Date(now.getTime() + 600_000);

async function fixture(
  run: (context: {
    repository: PostgresAgentTaskLeaseRepository;
    service: AgentTaskLeaseService;
    scope: {
      organizationId: string;
      projectId: string;
      taskId: string;
      operationMode: "execute";
      validUntil: string;
    };
    actor: { agentId: string; hostId: string };
    eventCount: () => Promise<number>;
  }) => Promise<void>,
) {
  const client = new Pool({ connectionString: databaseURL, max: 3 });
  await client.query("SELECT 1");
  const database = drizzle(client, { schema });
  const userId = crypto.randomUUID();
  const organizationId = `lease-cancel-${crypto.randomUUID()}`;
  const actor = { agentId: crypto.randomUUID(), hostId: crypto.randomUUID() };
  try {
    await database
      .insert(user)
      .values({ id: userId, name: "Cancellation tester", email: `${userId}@example.test` });
    await database
      .insert(organization)
      .values({ id: organizationId, name: "Cancellation", slug: organizationId, createdAt: now });
    await database
      .insert(agentHost)
      .values({ id: actor.hostId, userId, createdAt: now, updatedAt: now });
    await database.insert(agent).values({
      id: actor.agentId,
      hostId: actor.hostId,
      userId,
      name: "Test Agent",
      publicKey: "test-only",
      createdAt: now,
      updatedAt: now,
    });
    const [project] = await database
      .insert(pacaProjects)
      .values({ organizationId, createdBy: userId, name: "Cancellation", slug: organizationId })
      .returning();
    if (!project) throw Error("PROJECT_FIXTURE_MISSING");
    const [task] = await database
      .insert(pacaTasks)
      .values({ projectId: project.id, taskNumber: 1, title: "Cancellation" })
      .returning();
    if (!task) throw Error("TASK_FIXTURE_MISSING");
    const repository = new PostgresAgentTaskLeaseRepository(database);
    await run({
      repository,
      service: new AgentTaskLeaseService(repository),
      scope: {
        organizationId,
        projectId: project.id,
        taskId: task.id,
        operationMode: "execute",
        validUntil: expiry.toISOString(),
      },
      actor,
      eventCount: async () =>
        (
          await database
            .select({ id: pacaAgentTaskLeaseEvents.id })
            .from(pacaAgentTaskLeaseEvents)
            .innerJoin(
              schema.pacaAgentTaskLeases,
              eq(schema.pacaAgentTaskLeases.id, pacaAgentTaskLeaseEvents.leaseId),
            )
            .where(eq(schema.pacaAgentTaskLeases.agentId, actor.agentId))
        ).length,
    });
  } finally {
    await database.delete(organization).where(eq(organization.id, organizationId));
    await database.delete(user).where(eq(user.id, userId));
    await client.end();
  }
}

describe.skipIf(!databaseURL)("PostgreSQL Agent cancellation acknowledgement", () => {
  it("accepts the owner's acknowledgement after cancellation, preserves the stop, and deduplicates concurrent retries", async () =>
    fixture(async ({ repository, service, scope, actor, eventCount }) => {
      const claimed = await service.execute(
        actor,
        {
          ...scope,
          action: "claim",
          requestId: crypto.randomUUID(),
          leaseDurationMs: 60_000,
          harness: { kind: "codex" },
        },
        expiry,
        now,
      );
      const stoppedAt = new Date(now.getTime() + 1000);
      const cancelled = await repository.requestCancel({
        projectId: scope.projectId,
        taskId: scope.taskId,
        requestedBy: "test-user",
        requestId: crypto.randomUUID(),
        reason: "User stopped this task",
        now: stoppedAt,
      });
      const ack: AgentTaskLeaseCommand = {
        ...scope,
        leaseId: claimed.lease.id,
        action: "cancel_ack",
        requestId: crypto.randomUUID(),
        summary: "Host stopped local execution",
      };
      // Acknowledgement is still useful after the original execution lease ends.
      const ackAt = new Date(now.getTime() + 120_000);
      const results = await Promise.all([
        service.execute(actor, ack, expiry, ackAt),
        service.execute(actor, ack, expiry, ackAt),
      ]);
      expect(results.filter((result) => result.duplicate)).toHaveLength(1);
      for (const result of results) {
        expect(result.lease.status).toBe("cancelled");
        expect(result.lease.version).toBe(cancelled.lease.version + 1);
        expect(result.lease.finishedAt).toEqual(stoppedAt);
        expect(result.lease.leaseExpiresAt).toEqual(claimed.lease.leaseExpiresAt);
        expect(result.lease.resultSummary).toBe("User stopped this task");
      }
      expect(await eventCount()).toBe(3);
      await expect(service.execute(actor, ack, ackAt, ackAt)).rejects.toMatchObject({
        code: agentTaskLeaseErrorCodes.authorizationExpired,
      });
    }));

  it("keeps execution commands blocked and checks owner and scope before recording an ack", async () =>
    fixture(async ({ repository, service, scope, actor, eventCount }) => {
      const claimed = await service.execute(
        actor,
        {
          ...scope,
          action: "claim",
          requestId: crypto.randomUUID(),
          leaseDurationMs: 60_000,
          harness: { kind: "codex" },
        },
        expiry,
        now,
      );
      await repository.requestCancel({
        projectId: scope.projectId,
        taskId: scope.taskId,
        requestedBy: "test-user",
        requestId: crypto.randomUUID(),
        reason: null,
        now,
      });
      const base = { ...scope, leaseId: claimed.lease.id };
      for (const command of [
        { ...base, action: "renew", leaseDurationMs: 60_000 },
        { ...base, action: "checkpoint", sequence: 1 },
        { ...base, action: "complete" },
        { ...base, action: "fail", errorCode: "FAILED" },
      ])
        await expect(
          service.execute(actor, { ...command, requestId: crypto.randomUUID() }, expiry, now),
        ).rejects.toMatchObject({ code: agentTaskLeaseErrorCodes.leaseTerminal });
      const ack = { ...base, action: "cancel_ack", requestId: crypto.randomUUID() };
      await expect(
        service.execute({ ...actor, agentId: "other-agent" }, ack, expiry, now),
      ).rejects.toMatchObject({ code: agentTaskLeaseErrorCodes.leaseOwnerMismatch });
      await expect(
        service.execute({ ...actor, hostId: "other-host" }, ack, expiry, now),
      ).rejects.toMatchObject({ code: agentTaskLeaseErrorCodes.leaseOwnerMismatch });
      await expect(
        service.execute(actor, { ...ack, taskId: crypto.randomUUID() }, expiry, now),
      ).rejects.toMatchObject({ code: agentTaskLeaseErrorCodes.leaseScopeMismatch });
      expect(await eventCount()).toBe(2);
    }));

  it.each([
    "complete",
    "fail",
  ] as const)("does not acknowledge a %s terminal result as cancellation", async (action) =>
    fixture(async ({ service, scope, actor }) => {
      const claimed = await service.execute(
        actor,
        {
          ...scope,
          action: "claim",
          requestId: crypto.randomUUID(),
          leaseDurationMs: 60_000,
          harness: { kind: "codex" },
        },
        expiry,
        now,
      );
      const base = { ...scope, leaseId: claimed.lease.id };
      await service.execute(
        actor,
        {
          ...base,
          action,
          ...(action === "fail" ? { errorCode: "FAILED" } : {}),
          requestId: crypto.randomUUID(),
        },
        expiry,
        now,
      );
      await expect(
        service.execute(
          actor,
          { ...base, action: "cancel_ack", requestId: crypto.randomUUID() },
          expiry,
          now,
        ),
      ).rejects.toMatchObject({ code: agentTaskLeaseErrorCodes.leaseTerminal });
    }));
});
