import type { AppBindings } from "../bindings";
import { withDatabase } from "../database";
import type { PermissionGrant } from "../permission/statement";
import { PostgresOrganizationAccessRepository } from "./access-postgres-repository";
import {
  OrganizationAccessService,
  type OrganizationMember,
  type OrganizationRole,
  type OrganizationRoleInput,
} from "./access-service";

export type OrganizationAccessRuntime = {
  listRoles(env: AppBindings, organizationId: string): Promise<OrganizationRole[]>;
  createRole(
    env: AppBindings,
    actorGrants: readonly PermissionGrant[],
    organizationId: string,
    input: OrganizationRoleInput,
  ): Promise<OrganizationRole>;
  updateRole(
    env: AppBindings,
    actorGrants: readonly PermissionGrant[],
    organizationId: string,
    roleId: string,
    input: OrganizationRoleInput,
  ): Promise<OrganizationRole>;
  deleteRole(env: AppBindings, organizationId: string, roleId: string): Promise<void>;
  listMembers(env: AppBindings, organizationId: string): Promise<OrganizationMember[]>;
  replaceMemberRoles(
    env: AppBindings,
    actorGrants: readonly PermissionGrant[],
    organizationId: string,
    memberId: string,
    roleIds: readonly string[],
  ): Promise<OrganizationMember>;
};

function withService<T>(
  env: AppBindings,
  operation: (service: OrganizationAccessService) => Promise<T>,
): Promise<T> {
  return withDatabase(env, (database) =>
    operation(new OrganizationAccessService(new PostgresOrganizationAccessRepository(database))),
  );
}

export const organizationAccessRuntime: OrganizationAccessRuntime = {
  listRoles: (env, organizationId) =>
    withService(env, (service) => service.listRoles(organizationId)),
  createRole: (env, actorGrants, organizationId, input) =>
    withService(env, (service) => service.createRole(actorGrants, organizationId, input)),
  updateRole: (env, actorGrants, organizationId, roleId, input) =>
    withService(env, (service) => service.updateRole(actorGrants, organizationId, roleId, input)),
  deleteRole: (env, organizationId, roleId) =>
    withService(env, (service) => service.deleteRole(organizationId, roleId)),
  listMembers: (env, organizationId) =>
    withService(env, (service) => service.listMembers(organizationId)),
  replaceMemberRoles: (env, actorGrants, organizationId, memberId, roleIds) =>
    withService(env, (service) =>
      service.replaceMemberRoles(actorGrants, organizationId, memberId, roleIds),
    ),
};
