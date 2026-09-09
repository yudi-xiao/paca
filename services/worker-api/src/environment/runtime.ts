import type { AppBindings } from "../bindings";
import { withDatabase } from "../database";
import { PostgresEnvironmentScopeRepository } from "./postgres-repository";
import {
  listEnvironmentAgentIds,
  projectEnvironmentConnectionRevoker,
} from "./project-permission-revocation";
import {
  type EnvironmentCreateInput,
  type EnvironmentResource,
  EnvironmentResourceError,
  EnvironmentResourceService,
  type EnvironmentUpdateInput,
  environmentResourceErrorCodes,
} from "./service";

export type EnvironmentRuntime = {
  list(env: AppBindings, projectId: string): Promise<EnvironmentResource[]>;
  get(env: AppBindings, projectId: string, environmentId: string): Promise<EnvironmentResource>;
  create(
    env: AppBindings,
    projectId: string,
    createdBy: string,
    input: EnvironmentCreateInput,
  ): Promise<EnvironmentResource>;
  update(
    env: AppBindings,
    projectId: string,
    environmentId: string,
    input: EnvironmentUpdateInput,
  ): Promise<EnvironmentResource>;
  archive(env: AppBindings, projectId: string, environmentId: string): Promise<void>;
};

function withService<T>(
  env: AppBindings,
  operation: (service: EnvironmentResourceService) => Promise<T>,
): Promise<T> {
  return withDatabase(env, (database) =>
    operation(new EnvironmentResourceService(new PostgresEnvironmentScopeRepository(database))),
  );
}

export const environmentRuntime: EnvironmentRuntime = {
  list: (env, projectId) => withService(env, (service) => service.list(projectId)),
  get: (env, projectId, environmentId) =>
    withService(env, (service) => service.get(projectId, environmentId)),
  create: (env, projectId, createdBy, input) =>
    withService(env, (service) => service.create(projectId, createdBy, input)),
  update: (env, projectId, environmentId, input) =>
    withService(env, (service) => service.update(projectId, environmentId, input)),
  archive: async (env, projectId, environmentId) => {
    const agentIds = await withDatabase(env, async (database) => {
      const service = new EnvironmentResourceService(
        new PostgresEnvironmentScopeRepository(database),
      );
      await service.archive(projectId, environmentId);
      // Archive first: after this commit no new connection ticket can be
      // issued, while the historical Grant query below still covers every
      // Agent that could hold a pre-issued ticket or an active connection.
      return listEnvironmentAgentIds(database, projectId, environmentId);
    });
    const revocation = await projectEnvironmentConnectionRevoker(env).revokeEnvironment(
      projectId,
      environmentId,
      agentIds,
    );
    if (revocation.failed > 0) {
      throw new EnvironmentResourceError(environmentResourceErrorCodes.revocationFailed);
    }
  },
};
