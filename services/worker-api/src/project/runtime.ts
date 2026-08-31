import type { AppBindings } from "../bindings";
import { withDatabase } from "../database";
import { PostgresProjectRepository } from "./postgres-repository";
import {
  type Project,
  type ProjectCreateInput,
  type ProjectList,
  ProjectService,
  type ProjectStats,
  type ProjectUpdateInput,
} from "./service";

export type ProjectRuntime = {
  list(
    env: AppBindings,
    organizationId: string,
    page: number,
    pageSize: number,
  ): Promise<ProjectList>;
  stats(env: AppBindings, organizationId: string): Promise<ProjectStats>;
  get(env: AppBindings, projectId: string): Promise<Project>;
  create(
    env: AppBindings,
    organizationId: string,
    createdBy: string,
    input: ProjectCreateInput,
  ): Promise<Project>;
  update(env: AppBindings, projectId: string, input: ProjectUpdateInput): Promise<Project>;
  archive(env: AppBindings, projectId: string): Promise<void>;
};

function withService<T>(
  env: AppBindings,
  operation: (service: ProjectService) => Promise<T>,
): Promise<T> {
  return withDatabase(env, (database) =>
    operation(new ProjectService(new PostgresProjectRepository(database))),
  );
}

export const projectRuntime: ProjectRuntime = {
  list: (env, organizationId, page, pageSize) =>
    withService(env, (service) => service.list(organizationId, page, pageSize)),
  stats: (env, organizationId) => withService(env, (service) => service.stats(organizationId)),
  get: (env, projectId) => withService(env, (service) => service.get(projectId)),
  create: (env, organizationId, createdBy, input) =>
    withService(env, (service) => service.create(organizationId, createdBy, input)),
  update: (env, projectId, input) =>
    withService(env, (service) => service.update(projectId, input)),
  archive: (env, projectId) => withService(env, (service) => service.archive(projectId)),
};
