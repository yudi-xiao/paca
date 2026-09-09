import type { AppBindings } from "../bindings";
import { withDatabase } from "../database";
import { PostgresEnvironmentScopeRepository } from "./postgres-repository";
import {
  listEnvironmentAgentIds,
  listProjectEnvironmentUserIds,
  projectEnvironmentConnectionRevoker,
} from "./project-permission-revocation";
import {
  type EnvironmentConnection,
  EnvironmentConnectionError,
  EnvironmentConnectionService,
  type EnvironmentCreateInput,
  type EnvironmentResource,
  EnvironmentResourceError,
  EnvironmentResourceService,
  type EnvironmentUpdateInput,
  environmentConnectionErrorCodes,
  environmentResourceErrorCodes,
} from "./service";
import { ServiceBindingEnvironmentConnectionGateway } from "./service-binding-gateway";

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
  connectUser(
    env: AppBindings,
    projectId: string,
    environmentId: string,
    userId: string,
    sessionExpiresAt: Date,
  ): Promise<EnvironmentConnection>;
};

const USER_CONNECTION_AUTHORIZATION_MAX_MS = 15 * 60_000;

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
    const { agentIds, userIds } = await withDatabase(env, async (database) => {
      const service = new EnvironmentResourceService(
        new PostgresEnvironmentScopeRepository(database),
      );
      await service.archive(projectId, environmentId);
      // Archive first: after this commit no new connection ticket can be
      // issued, while the historical Grant query below still covers every
      // Agent that could hold a pre-issued ticket or an active connection.
      const [agentIds, userIds] = await Promise.all([
        listEnvironmentAgentIds(database, projectId, environmentId),
        listProjectEnvironmentUserIds(database, projectId),
      ]);
      return { agentIds, userIds };
    });
    const revocation = await projectEnvironmentConnectionRevoker(env).revokeEnvironment(
      projectId,
      environmentId,
      agentIds,
      userIds,
    );
    if (revocation.failed > 0) {
      throw new EnvironmentResourceError(environmentResourceErrorCodes.revocationFailed);
    }
  },
  connectUser: (env, projectId, environmentId, userId, sessionExpiresAt) =>
    withDatabase(env, async (database) => {
      const repository = new PostgresEnvironmentScopeRepository(database);
      const scope = await repository.find(environmentId);
      if (!scope || scope.projectId !== projectId) {
        throw new EnvironmentConnectionError(environmentConnectionErrorCodes.scopeMismatch);
      }
      const now = new Date();
      const authorizationExpiresAt = new Date(
        Math.min(sessionExpiresAt.getTime(), now.getTime() + USER_CONNECTION_AUTHORIZATION_MAX_MS),
      );
      const gateway = new ServiceBindingEnvironmentConnectionGateway(env.ENVIRONMENT_GATEWAY);
      const service = new EnvironmentConnectionService(
        { find: async (candidateId) => (candidateId === environmentId ? scope : null) },
        gateway,
      );
      const input = {
        requestId: crypto.randomUUID(),
        organizationId: scope.organizationId,
        projectId,
        environmentId,
        operationMode: "execute",
        actor: { type: "user", userId },
        authorizationExpiresAt,
      } as const;
      const warmup = await service.connect(input);
      await gateway.prepare(warmup);
      return service.connect({ ...input, requestId: crypto.randomUUID() });
    }),
};
