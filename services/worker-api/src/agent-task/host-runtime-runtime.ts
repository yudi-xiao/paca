import type { AgentSession } from "@better-auth/agent-auth";

import type { AppBindings } from "../bindings";
import { type PacaDatabase, withDatabase } from "../database";
import {
  type AgentHostRuntimeProfile,
  AgentHostRuntimeService,
  type AgentTaskRequirement,
} from "./host-runtime";
import { PostgresAgentHostRuntimeRepository } from "./postgres-host-runtime-repository";

export type AgentHostRuntime = {
  heartbeat(
    env: AppBindings,
    session: AgentSession,
    value: unknown,
  ): Promise<AgentHostRuntimeProfile>;
  approveLabels(
    env: AppBindings,
    hostId: string,
    approvedBy: string,
    value: unknown,
  ): Promise<AgentHostRuntimeProfile>;
  list(env: AppBindings): Promise<AgentHostRuntimeProfile[]>;
  getTaskRequirement(
    env: AppBindings,
    projectId: string,
    taskId: string,
  ): Promise<AgentTaskRequirement | null>;
  setTaskRequirement(
    env: AppBindings,
    projectId: string,
    taskId: string,
    updatedBy: string,
    value: unknown,
  ): Promise<AgentTaskRequirement>;
};

export function createPostgresAgentHostRuntimeService(database: PacaDatabase) {
  return new AgentHostRuntimeService(new PostgresAgentHostRuntimeRepository(database));
}

export const agentHostRuntime: AgentHostRuntime = {
  heartbeat: (env, session, value) =>
    withDatabase(env, (database) => {
      if (!session.host || session.agent.hostId !== session.host.id) {
        throw new Error("AGENT_HOST_IDENTITY_MISMATCH");
      }
      return createPostgresAgentHostRuntimeService(database).heartbeat(session.host.id, value);
    }),
  approveLabels: (env, hostId, approvedBy, value) =>
    withDatabase(env, (database) =>
      createPostgresAgentHostRuntimeService(database).approveLabels(hostId, approvedBy, value),
    ),
  list: (env) =>
    withDatabase(env, (database) => createPostgresAgentHostRuntimeService(database).list()),
  getTaskRequirement: (env, projectId, taskId) =>
    withDatabase(env, (database) =>
      createPostgresAgentHostRuntimeService(database).getTaskRequirement(projectId, taskId),
    ),
  setTaskRequirement: (env, projectId, taskId, updatedBy, value) =>
    withDatabase(env, (database) =>
      createPostgresAgentHostRuntimeService(database).setTaskRequirement(
        projectId,
        taskId,
        updatedBy,
        value,
      ),
    ),
};
