import type { AppBindings } from "../bindings";
import { withDatabase } from "../database";
import { PostgresTaskRepository } from "./postgres-repository";
import {
  type Task,
  type TaskCreateInput,
  type TaskList,
  type TaskListInput,
  TaskService,
  type TaskStatus,
  type TaskType,
  type TaskUpdateInput,
} from "./service";

export type TaskRuntime = {
  listTypes(env: AppBindings, projectId: string): Promise<TaskType[]>;
  listStatuses(env: AppBindings, projectId: string): Promise<TaskStatus[]>;
  list(env: AppBindings, projectId: string, input: TaskListInput): Promise<TaskList>;
  get(env: AppBindings, projectId: string, taskId: string): Promise<Task>;
  create(
    env: AppBindings,
    projectId: string,
    actorUserId: string,
    input: TaskCreateInput,
  ): Promise<Task>;
  update(
    env: AppBindings,
    projectId: string,
    taskId: string,
    actorUserId: string,
    input: TaskUpdateInput,
  ): Promise<Task>;
  archive(env: AppBindings, projectId: string, taskId: string, actorUserId: string): Promise<void>;
};

function withService<T>(
  env: AppBindings,
  operation: (service: TaskService) => Promise<T>,
): Promise<T> {
  return withDatabase(env, (database) =>
    operation(new TaskService(new PostgresTaskRepository(database))),
  );
}

export const taskRuntime: TaskRuntime = {
  listTypes: (env, projectId) => withService(env, (service) => service.listTypes(projectId)),
  listStatuses: (env, projectId) => withService(env, (service) => service.listStatuses(projectId)),
  list: (env, projectId, input) => withService(env, (service) => service.list(projectId, input)),
  get: (env, projectId, taskId) => withService(env, (service) => service.get(projectId, taskId)),
  create: (env, projectId, actorUserId, input) =>
    withService(env, (service) => service.create(projectId, actorUserId, input)),
  update: (env, projectId, taskId, actorUserId, input) =>
    withService(env, (service) => service.update(projectId, taskId, actorUserId, input)),
  archive: (env, projectId, taskId, actorUserId) =>
    withService(env, (service) => service.archive(projectId, taskId, actorUserId)),
};
