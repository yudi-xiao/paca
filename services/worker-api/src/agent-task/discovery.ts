import type { AgentSession } from "@better-auth/agent-auth";
import * as z from "zod";

import { evaluateAgentCapabilityGrant, exactConstraintString } from "../agent-auth/capabilities";
import type { AgentHarnessKind, AgentTaskLeaseStatus } from "./protocol";

export const MAX_AGENT_TASK_DISCOVERY_ITEMS = 100;

const grantScopeSchema = z.object({
  organizationId: z.string().min(1).max(255),
  projectId: z.uuid(),
  taskId: z.uuid(),
  validUntil: z.iso.datetime(),
});

export type AgentTaskGrantScope = z.infer<typeof grantScopeSchema> & {
  validUntilDate: Date;
};

export type AgentTaskDiscoveryTask = {
  id: string;
  projectId: string;
  taskNumber: number;
  title: string;
  statusId: string | null;
  updatedAt: Date;
};

export type AgentTaskDiscoveryLease = {
  id: string;
  taskId: string;
  agentId: string;
  hostId: string;
  harnessKind: AgentHarnessKind;
  harnessVersion: string | null;
  harnessInstanceId: string | null;
  status: AgentTaskLeaseStatus;
  version: number;
  lastCheckpointSequence: number;
  leaseExpiresAt: Date;
};

export type AgentTaskDiscoveryItem = {
  organizationId: string;
  projectId: string;
  taskId: string;
  taskNumber: number;
  title: string;
  statusId: string | null;
  taskUpdatedAt: Date;
  validUntil: string;
  availability: "claimable" | "owned";
  lease: Omit<AgentTaskDiscoveryLease, "agentId" | "hostId" | "taskId"> | null;
};

export type AgentTaskDiscoveryDependencies = {
  authorizeScope(session: AgentSession, scope: AgentTaskGrantScope): Promise<boolean>;
  matchTasks(
    session: AgentSession,
    scopes: readonly AgentTaskGrantScope[],
    now: Date,
  ): Promise<Set<string>>;
  findTasks(scopes: readonly AgentTaskGrantScope[]): Promise<AgentTaskDiscoveryTask[]>;
  findActiveLeases(taskIds: readonly string[], now: Date): Promise<AgentTaskDiscoveryLease[]>;
};

function grantScope(
  grant: AgentSession["agent"]["capabilityGrants"][number],
  now: Date,
): AgentTaskGrantScope | null {
  if (grant.capability !== "task.execute" || grant.status !== "active") return null;
  const parsed = grantScopeSchema.safeParse({
    organizationId: exactConstraintString(grant.constraints?.organizationId),
    projectId: exactConstraintString(grant.constraints?.projectId),
    taskId: exactConstraintString(grant.constraints?.taskId),
    validUntil: exactConstraintString(grant.constraints?.validUntil),
  });
  if (!parsed.success) return null;

  const claim = evaluateAgentCapabilityGrant(
    grant,
    "task.execute",
    { ...parsed.data, operationMode: "execute", action: "claim" },
    now,
  );
  if (!claim.allowed) return null;

  const validUntilDate = new Date(parsed.data.validUntil);
  if (validUntilDate <= now) return null;
  return { ...parsed.data, validUntilDate };
}

function discoverableScopes(session: AgentSession, now: Date): AgentTaskGrantScope[] {
  const selected = new Map<string, AgentTaskGrantScope>();
  for (const grant of session.agent.capabilityGrants) {
    const scope = grantScope(grant, now);
    if (!scope) continue;
    const current = selected.get(scope.taskId);
    if (!current || current.validUntilDate < scope.validUntilDate) {
      selected.set(scope.taskId, scope);
    }
  }
  return [...selected.values()]
    .sort((left, right) => left.taskId.localeCompare(right.taskId))
    .slice(0, MAX_AGENT_TASK_DISCOVERY_ITEMS);
}

export async function discoverAgentTasks(
  dependencies: AgentTaskDiscoveryDependencies,
  session: AgentSession,
  now = new Date(),
): Promise<AgentTaskDiscoveryItem[]> {
  if (!session.host || session.agent.hostId !== session.host.id) return [];
  const candidates = discoverableScopes(session, now);
  if (candidates.length === 0) return [];

  const authorization = await Promise.all(
    candidates.map(async (scope) => ({
      scope,
      allowed: await dependencies.authorizeScope(session, scope),
    })),
  );
  const scopes = authorization.filter(({ allowed }) => allowed).map(({ scope }) => scope);
  if (scopes.length === 0) return [];

  const matchedTaskIds = await dependencies.matchTasks(session, scopes, now);
  const matchedScopes = scopes.filter(({ taskId }) => matchedTaskIds.has(taskId));
  if (matchedScopes.length === 0) return [];

  const [tasks, leases] = await Promise.all([
    dependencies.findTasks(matchedScopes),
    dependencies.findActiveLeases(
      matchedScopes.map(({ taskId }) => taskId),
      now,
    ),
  ]);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const leaseByTaskId = new Map(leases.map((lease) => [lease.taskId, lease]));

  return matchedScopes.flatMap((scope): AgentTaskDiscoveryItem[] => {
    const task = taskById.get(scope.taskId);
    if (!task || task.projectId !== scope.projectId) return [];
    const activeLease = leaseByTaskId.get(scope.taskId) ?? null;
    if (
      activeLease &&
      (activeLease.agentId !== session.agentId || activeLease.hostId !== session.host?.id)
    ) {
      return [];
    }
    return [
      {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        taskId: scope.taskId,
        taskNumber: task.taskNumber,
        title: task.title,
        statusId: task.statusId,
        taskUpdatedAt: task.updatedAt,
        validUntil: scope.validUntil,
        availability: activeLease ? "owned" : "claimable",
        lease: activeLease
          ? {
              id: activeLease.id,
              harnessKind: activeLease.harnessKind,
              harnessVersion: activeLease.harnessVersion,
              harnessInstanceId: activeLease.harnessInstanceId,
              status: activeLease.status,
              version: activeLease.version,
              lastCheckpointSequence: activeLease.lastCheckpointSequence,
              leaseExpiresAt: activeLease.leaseExpiresAt,
            }
          : null,
      },
    ];
  });
}
