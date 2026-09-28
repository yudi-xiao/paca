import type { AppBindings } from "../bindings";
import { withDatabase } from "../database";
import {
  type AutomationEdgeRow,
  type AutomationGraphRows,
  type AutomationNodeRow,
  type AutomationRow,
  PostgresAutomationRepository,
} from "./postgres-repository";

export type AutomationRuntime = {
  list(
    env: AppBindings,
    projectId: string,
    status?: "active" | "inactive",
  ): Promise<AutomationRow[]>;
  create(
    env: AppBindings,
    input: { projectId: string; actorUserId: string; name: string; description?: string },
  ): Promise<AutomationRow>;
  getGraph(env: AppBindings, projectId: string, automationId: string): Promise<AutomationGraphRows>;
  update(
    env: AppBindings,
    projectId: string,
    automationId: string,
    input: { name?: string; description?: string },
  ): Promise<AutomationRow>;
  archive(env: AppBindings, projectId: string, automationId: string): Promise<void>;
  addNode(
    env: AppBindings,
    projectId: string,
    automationId: string,
    input: { kind: string; type: string; config: unknown; posX: number; posY: number },
  ): Promise<AutomationNodeRow>;
  updateNode(
    env: AppBindings,
    projectId: string,
    automationId: string,
    nodeId: string,
    input: { config?: unknown; posX?: number; posY?: number },
  ): Promise<AutomationNodeRow>;
  removeNode(
    env: AppBindings,
    projectId: string,
    automationId: string,
    nodeId: string,
  ): Promise<void>;
  addEdge(
    env: AppBindings,
    projectId: string,
    automationId: string,
    input: { sourceNodeId: string; sourceHandle?: string | null; targetNodeId: string },
  ): Promise<AutomationEdgeRow>;
  removeEdge(
    env: AppBindings,
    projectId: string,
    automationId: string,
    edgeId: string,
  ): Promise<void>;
};

function withRepository<T>(
  env: AppBindings,
  operation: (repository: PostgresAutomationRepository) => Promise<T>,
): Promise<T> {
  return withDatabase(env, (database) => operation(new PostgresAutomationRepository(database)));
}

export const automationRuntime: AutomationRuntime = {
  list: (env, projectId, status) =>
    withRepository(env, (repository) => repository.list(projectId, status)),
  create: (env, input) => withRepository(env, (repository) => repository.create(input)),
  getGraph: (env, projectId, automationId) =>
    withRepository(env, (repository) => repository.getGraph(projectId, automationId)),
  update: (env, projectId, automationId, input) =>
    withRepository(env, (repository) => repository.update(projectId, automationId, input)),
  archive: (env, projectId, automationId) =>
    withRepository(env, (repository) => repository.archive(projectId, automationId)),
  addNode: (env, projectId, automationId, input) =>
    withRepository(env, (repository) => repository.addNode(projectId, automationId, input)),
  updateNode: (env, projectId, automationId, nodeId, input) =>
    withRepository(env, (repository) =>
      repository.updateNode(projectId, automationId, nodeId, input),
    ),
  removeNode: (env, projectId, automationId, nodeId) =>
    withRepository(env, (repository) => repository.removeNode(projectId, automationId, nodeId)),
  addEdge: (env, projectId, automationId, input) =>
    withRepository(env, (repository) => repository.addEdge(projectId, automationId, input)),
  removeEdge: (env, projectId, automationId, edgeId) =>
    withRepository(env, (repository) => repository.removeEdge(projectId, automationId, edgeId)),
};
