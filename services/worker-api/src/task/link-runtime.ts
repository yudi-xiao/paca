import type { AppBindings } from "../bindings";
import { withDatabase } from "../database";
import { type LinkType, type TaskLink, TaskLinkService } from "./link-service";
import { PostgresTaskLinkRepository } from "./postgres-link-repository";

export type TaskLinkRuntime = {
  list(env: AppBindings, projectId: string, taskId: string): Promise<TaskLink[]>;
  create(
    env: AppBindings,
    projectId: string,
    sourceTaskId: string,
    actorUserId: string,
    input: { targetTaskId: string; linkType: LinkType },
  ): Promise<TaskLink>;
  delete(
    env: AppBindings,
    projectId: string,
    taskId: string,
    linkId: string,
    actorUserId: string,
  ): Promise<void>;
};

function withService<T>(
  env: AppBindings,
  operation: (service: TaskLinkService) => Promise<T>,
): Promise<T> {
  return withDatabase(env, (database) =>
    operation(new TaskLinkService(new PostgresTaskLinkRepository(database))),
  );
}

export const taskLinkRuntime: TaskLinkRuntime = {
  list: (env, projectId, taskId) => withService(env, (service) => service.list(projectId, taskId)),
  create: (env, projectId, sourceTaskId, actorUserId, input) =>
    withService(env, (service) =>
      service.create({ projectId, sourceTaskId, actorUserId, ...input }),
    ),
  delete: (env, projectId, taskId, linkId, actorUserId) =>
    withService(env, (service) => service.delete(projectId, taskId, linkId, actorUserId)),
};
