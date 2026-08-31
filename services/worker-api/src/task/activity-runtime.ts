import type { AppBindings } from "../bindings";
import { withDatabase } from "../database";
import { type TaskActivity, TaskActivityService } from "./activity-service";
import { PostgresTaskActivityRepository } from "./postgres-activity-repository";

export type TaskActivityRuntime = {
  list(env: AppBindings, projectId: string, taskId: string): Promise<TaskActivity[]>;
  createComment(
    env: AppBindings,
    projectId: string,
    taskId: string,
    actorUserId: string,
    content: unknown,
  ): Promise<TaskActivity>;
  updateComment(
    env: AppBindings,
    projectId: string,
    taskId: string,
    commentId: string,
    actorUserId: string,
    content: unknown,
  ): Promise<TaskActivity>;
  deleteComment(
    env: AppBindings,
    projectId: string,
    taskId: string,
    commentId: string,
    actorUserId: string,
  ): Promise<void>;
};

function withService<T>(
  env: AppBindings,
  operation: (service: TaskActivityService) => Promise<T>,
): Promise<T> {
  return withDatabase(env, (database) =>
    operation(new TaskActivityService(new PostgresTaskActivityRepository(database))),
  );
}

export const taskActivityRuntime: TaskActivityRuntime = {
  list: (env, projectId, taskId) => withService(env, (service) => service.list(projectId, taskId)),
  createComment: (env, projectId, taskId, actorUserId, content) =>
    withService(env, (service) => service.createComment(projectId, taskId, actorUserId, content)),
  updateComment: (env, projectId, taskId, commentId, actorUserId, content) =>
    withService(env, (service) =>
      service.updateComment(projectId, taskId, commentId, actorUserId, content),
    ),
  deleteComment: (env, projectId, taskId, commentId, actorUserId) =>
    withService(env, (service) => service.deleteComment(projectId, taskId, commentId, actorUserId)),
};
