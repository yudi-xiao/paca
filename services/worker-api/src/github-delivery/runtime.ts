import type { AppBindings } from "../bindings";
import { withDatabase } from "../database";
import { authorizeProjectPermission, authorizeSystemPermission } from "../permission/http";
import { GitHubAppDeliverySource } from "./github-app";
import { PostgresGitHubDeliveryRepository } from "./postgres-repository";
import {
  type CompletedDeliveryRunPage,
  DeliveryWorkflowError,
  type GitHubDeliveryRepository,
  GitHubDeliveryService,
  type RepositoryBinding,
  type TaskDelivery,
} from "./service";

export type GitHubDeliveryRuntime = {
  completedRuns(
    env: AppBindings,
    projectId: string,
    taskId: string,
    cursor?: string,
  ): Promise<CompletedDeliveryRunPage>;
  binding(env: AppBindings, projectId: string): Promise<RepositoryBinding | null>;
  delivery(env: AppBindings, projectId: string, taskId: string): Promise<TaskDelivery | null>;
  configure(
    env: AppBindings,
    request: Request,
    projectId: string,
    actorId: string,
    input: unknown,
  ): Promise<RepositoryBinding>;
  submit(
    env: AppBindings,
    request: Request,
    projectId: string,
    taskId: string,
    actorId: string,
    input: unknown,
  ): Promise<TaskDelivery>;
  refresh(
    env: AppBindings,
    request: Request,
    projectId: string,
    taskId: string,
    actorId: string,
    input: unknown,
  ): Promise<TaskDelivery>;
  decide(
    env: AppBindings,
    request: Request,
    projectId: string,
    taskId: string,
    actorId: string,
    input: unknown,
  ): Promise<TaskDelivery>;
};
function repository(env: AppBindings): GitHubDeliveryRepository {
  return {
    binding: (projectId) =>
      withDatabase(env, (db) => new PostgresGitHubDeliveryRepository(db).binding(projectId)),
    delivery: (projectId, taskId) =>
      withDatabase(env, (db) =>
        new PostgresGitHubDeliveryRepository(db).delivery(projectId, taskId),
      ),
    configure: (projectId, actorId, input, now) =>
      withDatabase(env, (db) =>
        new PostgresGitHubDeliveryRepository(db).configure(projectId, actorId, input, now),
      ),
    write: (input) =>
      withDatabase(env, (db) => new PostgresGitHubDeliveryRepository(db).write(input)),
  };
}
function service(env: AppBindings, request: Request) {
  return new GitHubDeliveryService(
    repository(env),
    new GitHubAppDeliverySource({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
    }),
    async (projectId, actorId, configure) => {
      const project = await authorizeProjectPermission(
        request,
        env,
        projectId,
        configure ? { projects: ["write"] } : { tasks: ["write"] },
      );
      if (
        !project.authenticated ||
        project.userId !== actorId ||
        !project.decision.allowed ||
        !project.decision.scopeExists
      )
        throw new DeliveryWorkflowError("DELIVERY_PERMISSION_DENIED");
      if (configure) {
        const system = await authorizeSystemPermission(request, env, { settings: ["write"] });
        if (!system.authenticated || system.userId !== actorId || !system.allowed)
          throw new DeliveryWorkflowError("DELIVERY_PERMISSION_DENIED");
      }
    },
  );
}
export const githubDeliveryRuntime: GitHubDeliveryRuntime = {
  completedRuns: (env, projectId, taskId, cursor) =>
    withDatabase(env, (db) =>
      new PostgresGitHubDeliveryRepository(db).completedRuns(projectId, taskId, cursor),
    ),
  binding: (env, projectId) => repository(env).binding(projectId),
  delivery: (env, projectId, taskId) => repository(env).delivery(projectId, taskId),
  configure: (env, request, projectId, actorId, input) =>
    service(env, request).configure(projectId, actorId, input),
  submit: (env, request, projectId, taskId, actorId, input) =>
    service(env, request).submit(projectId, taskId, actorId, input),
  refresh: (env, request, projectId, taskId, actorId, input) =>
    service(env, request).refresh(projectId, taskId, actorId, input),
  decide: (env, request, projectId, taskId, actorId, input) =>
    service(env, request).decide(projectId, taskId, actorId, input),
};
