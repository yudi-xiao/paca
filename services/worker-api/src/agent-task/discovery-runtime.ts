import type { AgentSession } from "@better-auth/agent-auth";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";

import type { AppBindings } from "../bindings";
import { type PacaDatabase, withDatabase } from "../database";
import { pacaAgentTaskLeases, pacaTasks } from "../db/schema";
import { PostgresPacaPermissionStore } from "../permission/postgres-store";
import { PacaPermissionService } from "../permission/service";
import {
  type AgentTaskDiscoveryDependencies,
  type AgentTaskDiscoveryItem,
  type AgentTaskGrantScope,
  discoverAgentTasks,
} from "./discovery";
import { createPostgresAgentHostRuntimeService } from "./host-runtime-runtime";
import { agentHarnessSchema } from "./protocol";

export type AgentTaskDiscoveryRuntime = {
  list(env: AppBindings, session: AgentSession): Promise<AgentTaskDiscoveryItem[]>;
};

function postgresDependencies(database: PacaDatabase): AgentTaskDiscoveryDependencies {
  const permissionStore = new PostgresPacaPermissionStore(database);
  const permissionService = new PacaPermissionService(permissionStore);
  return {
    async authorizeScope(session, scope) {
      if (
        (await permissionStore.findProjectOrganization(scope.projectId)) !== scope.organizationId
      ) {
        return false;
      }
      if (session.type === "autonomous") return true;
      if (!session.userId) return false;
      const decision = await permissionService.hasProjectPermission(
        session.userId,
        scope.projectId,
        {
          tasks: ["read"],
        },
      );
      return decision.scopeExists && decision.allowed;
    },
    async matchTasks(session, scopes, now) {
      if (!session.host || session.agent.hostId !== session.host.id) return new Set();
      return createPostgresAgentHostRuntimeService(database).matchTasks(
        session.host.id,
        scopes.map(({ taskId }) => taskId),
        now,
      );
    },
    async findTasks(scopes: readonly AgentTaskGrantScope[]) {
      if (scopes.length === 0) return [];
      return database
        .select({
          id: pacaTasks.id,
          projectId: pacaTasks.projectId,
          taskNumber: pacaTasks.taskNumber,
          title: pacaTasks.title,
          statusId: pacaTasks.statusId,
          updatedAt: pacaTasks.updatedAt,
        })
        .from(pacaTasks)
        .where(
          and(
            inArray(
              pacaTasks.id,
              scopes.map(({ taskId }) => taskId),
            ),
            isNull(pacaTasks.deletedAt),
          ),
        );
    },
    async findActiveLeases(taskIds, now) {
      if (taskIds.length === 0) return [];
      const rows = await database
        .select({
          id: pacaAgentTaskLeases.id,
          taskId: pacaAgentTaskLeases.taskId,
          agentId: pacaAgentTaskLeases.agentId,
          hostId: pacaAgentTaskLeases.hostId,
          harnessKind: pacaAgentTaskLeases.harnessKind,
          harnessVersion: pacaAgentTaskLeases.harnessVersion,
          harnessInstanceId: pacaAgentTaskLeases.harnessInstanceId,
          status: pacaAgentTaskLeases.status,
          version: pacaAgentTaskLeases.version,
          lastCheckpointSequence: pacaAgentTaskLeases.lastCheckpointSequence,
          leaseExpiresAt: pacaAgentTaskLeases.leaseExpiresAt,
        })
        .from(pacaAgentTaskLeases)
        .where(
          and(
            inArray(pacaAgentTaskLeases.taskId, [...taskIds]),
            eq(pacaAgentTaskLeases.status, "active"),
            gt(pacaAgentTaskLeases.leaseExpiresAt, now),
          ),
        );
      return rows.flatMap((row) => {
        const harness = agentHarnessSchema.safeParse({
          kind: row.harnessKind,
          version: row.harnessVersion ?? undefined,
          instanceId: row.harnessInstanceId ?? undefined,
        });
        return [{ ...row, harnessKind: harness.success ? harness.data.kind : "custom" }];
      });
    },
  };
}

export const agentTaskDiscoveryRuntime: AgentTaskDiscoveryRuntime = {
  list: (env, session) =>
    withDatabase(env, (database) => discoverAgentTasks(postgresDependencies(database), session)),
};
