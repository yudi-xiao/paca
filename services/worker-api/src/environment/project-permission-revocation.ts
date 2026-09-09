import { and, eq, inArray, like } from "drizzle-orm";
import * as z from "zod";

import { exactConstraintString } from "../agent-auth/capabilities";
import type { AppBindings } from "../bindings";
import type { PacaDatabase } from "../database";
import { agent, agentCapabilityGrant, pacaProjectMembers } from "../db/schema";
import { hasEveryPermission } from "../permission/evaluator";
import { PostgresPacaPermissionStore } from "../permission/postgres-store";
import { PacaPermissionService } from "../permission/service";
import { ServiceBindingEnvironmentConnectionGateway } from "./service-binding-gateway";

const MAX_PRINCIPALS_PER_GATEWAY_REQUEST = 100;
const constraintsSchema = z.record(z.string(), z.unknown());

export type ProjectEnvironmentPermissionState = {
  read: boolean;
  connect: boolean;
};

export type ProjectEnvironmentPermissionSnapshot = Map<string, ProjectEnvironmentPermissionState>;

export type ProjectConnectionRevocationGateway = Pick<
  ServiceBindingEnvironmentConnectionGateway,
  "revokeProjectConnections" | "revokeEnvironmentConnections"
>;

type ConnectionPrincipal = { type: "agent"; id: string } | { type: "user"; id: string };

function principalBatches(
  agentIds: readonly string[],
  userIds: readonly string[],
): Array<{ agentIds: string[]; userIds: string[] }> {
  const principals: ConnectionPrincipal[] = [
    ...[...new Set(agentIds)].map((id) => ({ type: "agent" as const, id })),
    ...[...new Set(userIds)].map((id) => ({ type: "user" as const, id })),
  ];
  const batches: Array<{ agentIds: string[]; userIds: string[] }> = [];
  for (let offset = 0; offset < principals.length; offset += MAX_PRINCIPALS_PER_GATEWAY_REQUEST) {
    const batch = principals.slice(offset, offset + MAX_PRINCIPALS_PER_GATEWAY_REQUEST);
    batches.push({
      agentIds: batch.filter((principal) => principal.type === "agent").map(({ id }) => id),
      userIds: batch.filter((principal) => principal.type === "user").map(({ id }) => id),
    });
  }
  return batches;
}

export async function listProjectEnvironmentUserIds(
  database: PacaDatabase,
  projectId: string,
): Promise<string[]> {
  const rows = await database
    .select({ userId: pacaProjectMembers.userId })
    .from(pacaProjectMembers)
    .where(eq(pacaProjectMembers.projectId, projectId));
  return [...new Set(rows.map(({ userId }) => userId))];
}

export async function readProjectEnvironmentPermissionSnapshot(
  database: PacaDatabase,
  projectId: string,
  userIds: readonly string[],
): Promise<ProjectEnvironmentPermissionSnapshot> {
  const service = new PacaPermissionService(new PostgresPacaPermissionStore(database));
  const snapshot: ProjectEnvironmentPermissionSnapshot = new Map();
  const permissionSets = await service.listProjectPermissionsForUsers([...userIds], projectId);
  for (const [userId, grants] of permissionSets) {
    snapshot.set(userId, {
      read: Boolean(
        grants && hasEveryPermission(grants, [{ resource: "environments", action: "read" }]),
      ),
      connect: Boolean(
        grants && hasEveryPermission(grants, [{ resource: "environments", action: "connect" }]),
      ),
    });
  }
  return snapshot;
}

export function usersWithProjectEnvironmentPermissionLoss(
  before: ReadonlyMap<string, ProjectEnvironmentPermissionState>,
  after: ReadonlyMap<string, ProjectEnvironmentPermissionState>,
): string[] {
  const userIds: string[] = [];
  for (const [userId, previous] of before) {
    const current = after.get(userId) ?? { read: false, connect: false };
    if ((previous.read && !current.read) || (previous.connect && !current.connect)) {
      userIds.push(userId);
    }
  }
  return userIds;
}

export async function listDelegatedAgentIds(
  database: PacaDatabase,
  userIds: readonly string[],
): Promise<string[]> {
  const uniqueUserIds = [...new Set(userIds)];
  if (uniqueUserIds.length === 0) return [];
  const rows = await database
    .select({ agentId: agent.id })
    .from(agent)
    .where(and(eq(agent.mode, "delegated"), inArray(agent.userId, uniqueUserIds)));
  return [...new Set(rows.map(({ agentId }) => agentId))];
}

export async function listProjectEnvironmentAgentIds(
  database: PacaDatabase,
  projectId: string,
): Promise<string[]> {
  const rows = await database
    .select({
      agentId: agent.id,
      constraints: agentCapabilityGrant.constraints,
    })
    .from(agent)
    .innerJoin(
      agentCapabilityGrant,
      and(
        eq(agentCapabilityGrant.agentId, agent.id),
        eq(agentCapabilityGrant.capability, "environment.connect"),
        eq(agentCapabilityGrant.status, "active"),
        like(agentCapabilityGrant.constraints, `%${projectId}%`),
      ),
    );

  const agentIds = new Set<string>();
  for (const row of rows) {
    if (!row.constraints) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.constraints);
    } catch {
      continue;
    }
    const constraints = constraintsSchema.safeParse(parsed);
    if (constraints.success && exactConstraintString(constraints.data.projectId) === projectId) {
      agentIds.add(row.agentId);
    }
  }
  return [...agentIds];
}

export async function listEnvironmentAgentIds(
  database: PacaDatabase,
  projectId: string,
  environmentId: string,
): Promise<string[]> {
  const rows = await database
    .select({
      agentId: agent.id,
      constraints: agentCapabilityGrant.constraints,
    })
    .from(agent)
    .innerJoin(
      agentCapabilityGrant,
      and(
        eq(agentCapabilityGrant.agentId, agent.id),
        eq(agentCapabilityGrant.capability, "environment.connect"),
        like(agentCapabilityGrant.constraints, `%${environmentId}%`),
      ),
    );

  const agentIds = new Set<string>();
  for (const row of rows) {
    if (!row.constraints) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.constraints);
    } catch {
      continue;
    }
    const constraints = constraintsSchema.safeParse(parsed);
    if (
      constraints.success &&
      exactConstraintString(constraints.data.projectId) === projectId &&
      exactConstraintString(constraints.data.environmentId) === environmentId
    ) {
      agentIds.add(row.agentId);
    }
  }
  return [...agentIds];
}

export class ProjectEnvironmentConnectionRevoker {
  constructor(private readonly gateway: ProjectConnectionRevocationGateway) {}

  async revoke(
    projectId: string,
    agentIds: readonly string[],
    userIds: readonly string[] = [],
  ): Promise<{
    requested: number;
    terminated: number;
    pending: number;
    failed: number;
  }> {
    const uniqueAgentIds = [...new Set(agentIds)];
    const uniqueUserIds = [...new Set(userIds)];
    let terminated = 0;
    let pending = 0;
    let failed = 0;
    for (const { agentIds: agentBatch, userIds: userBatch } of principalBatches(
      uniqueAgentIds,
      uniqueUserIds,
    )) {
      try {
        const result = await this.gateway.revokeProjectConnections(
          projectId,
          agentBatch,
          userBatch,
        );
        terminated += result.terminated;
        pending += result.pending;
      } catch {
        failed += agentBatch.length + userBatch.length;
        console.error(
          JSON.stringify({
            level: "error",
            message: "environment.project_connection.revocation_notification_failed",
            projectId,
            agentCount: agentBatch.length,
            userCount: userBatch.length,
          }),
        );
      }
    }
    return { requested: uniqueAgentIds.length + uniqueUserIds.length, terminated, pending, failed };
  }

  async revokeEnvironment(
    projectId: string,
    environmentId: string,
    agentIds: readonly string[],
    userIds: readonly string[] = [],
  ): Promise<{
    requested: number;
    terminated: number;
    pending: number;
    failed: number;
  }> {
    const uniqueAgentIds = [...new Set(agentIds)];
    const uniqueUserIds = [...new Set(userIds)];
    let terminated = 0;
    let pending = 0;
    let failed = 0;
    const batches = principalBatches(uniqueAgentIds, uniqueUserIds);
    if (batches.length === 0) batches.push({ agentIds: [], userIds: [] });
    for (const { agentIds: agentBatch, userIds: userBatch } of batches) {
      try {
        const result = await this.gateway.revokeEnvironmentConnections(
          projectId,
          environmentId,
          agentBatch,
          userBatch,
        );
        terminated += result.terminated;
        pending += result.pending;
      } catch {
        // The empty batch is a real Environment-wide barrier notification.
        // Count its failure so archive returns a retryable error instead of
        // claiming that revocation succeeded.
        failed += Math.max(1, agentBatch.length + userBatch.length);
        console.error(
          JSON.stringify({
            level: "error",
            message: "environment.resource_connection.revocation_notification_failed",
            projectId,
            environmentId,
            agentCount: agentBatch.length,
            userCount: userBatch.length,
          }),
        );
      }
    }
    return { requested: uniqueAgentIds.length + uniqueUserIds.length, terminated, pending, failed };
  }
}

export function projectEnvironmentConnectionRevoker(
  env: AppBindings,
): ProjectEnvironmentConnectionRevoker {
  return new ProjectEnvironmentConnectionRevoker(
    new ServiceBindingEnvironmentConnectionGateway(env.ENVIRONMENT_GATEWAY),
  );
}
