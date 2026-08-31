import type { AppBindings } from "../bindings";
import { withDatabase } from "../database";
import { PostgresSystemRoleRepository } from "./postgres-system-role-repository";
import type { PermissionGrant } from "./statement";
import { type SystemRole, type SystemRoleInput, SystemRoleService } from "./system-role-service";

export type SystemRoleRuntime = {
  list(env: AppBindings): Promise<SystemRole[]>;
  create(
    env: AppBindings,
    actorGrants: readonly PermissionGrant[],
    input: SystemRoleInput,
  ): Promise<SystemRole>;
  update(
    env: AppBindings,
    actorGrants: readonly PermissionGrant[],
    roleId: string,
    input: SystemRoleInput,
  ): Promise<SystemRole>;
  delete(env: AppBindings, roleId: string): Promise<void>;
  replaceUserRoles(
    env: AppBindings,
    actorGrants: readonly PermissionGrant[],
    userId: string,
    roleIds: readonly string[],
  ): Promise<SystemRole[]>;
};

function withService<T>(
  env: AppBindings,
  operation: (service: SystemRoleService) => Promise<T>,
): Promise<T> {
  return withDatabase(env, (database) =>
    operation(new SystemRoleService(new PostgresSystemRoleRepository(database))),
  );
}

export const systemRoleRuntime: SystemRoleRuntime = {
  list: (env) => withService(env, (service) => service.list()),
  create: (env, actorGrants, input) =>
    withService(env, (service) => service.create(actorGrants, input)),
  update: (env, actorGrants, roleId, input) =>
    withService(env, (service) => service.update(actorGrants, roleId, input)),
  delete: (env, roleId) => withService(env, (service) => service.delete(roleId)),
  replaceUserRoles: (env, actorGrants, userId, roleIds) =>
    withService(env, (service) => service.replaceUserRoles(actorGrants, userId, roleIds)),
};
