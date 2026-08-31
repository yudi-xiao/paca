import type { AppBindings } from "../bindings";
import { withDatabase } from "../database";
import type { PermissionGrant } from "../permission/statement";
import { PostgresProjectAccessRepository } from "./access-postgres-repository";
import {
  type DirectoryUserList,
  ProjectAccessService,
  type ProjectMember,
  type ProjectRole,
  type ProjectRoleInput,
} from "./access-service";

export type ProjectAccessRuntime = {
  listRoles(env: AppBindings, projectId: string): Promise<ProjectRole[]>;
  createRole(
    env: AppBindings,
    actorGrants: readonly PermissionGrant[],
    projectId: string,
    input: ProjectRoleInput,
  ): Promise<ProjectRole>;
  updateRole(
    env: AppBindings,
    actorGrants: readonly PermissionGrant[],
    projectId: string,
    roleId: string,
    input: ProjectRoleInput,
  ): Promise<ProjectRole>;
  deleteRole(env: AppBindings, projectId: string, roleId: string): Promise<void>;
  listMembers(env: AppBindings, projectId: string): Promise<ProjectMember[]>;
  addMember(
    env: AppBindings,
    actorGrants: readonly PermissionGrant[],
    projectId: string,
    userId: string,
    roleId: string,
  ): Promise<ProjectMember>;
  replaceMemberRole(
    env: AppBindings,
    actorGrants: readonly PermissionGrant[],
    projectId: string,
    memberId: string,
    roleId: string,
  ): Promise<ProjectMember>;
  removeMember(env: AppBindings, projectId: string, memberId: string): Promise<void>;
  listUsers(env: AppBindings, page: number, pageSize: number): Promise<DirectoryUserList>;
};

function withService<T>(
  env: AppBindings,
  operation: (service: ProjectAccessService) => Promise<T>,
): Promise<T> {
  return withDatabase(env, (database) =>
    operation(new ProjectAccessService(new PostgresProjectAccessRepository(database))),
  );
}

export const projectAccessRuntime: ProjectAccessRuntime = {
  listRoles: (env, projectId) => withService(env, (service) => service.listRoles(projectId)),
  createRole: (env, actorGrants, projectId, input) =>
    withService(env, (service) => service.createRole(actorGrants, projectId, input)),
  updateRole: (env, actorGrants, projectId, roleId, input) =>
    withService(env, (service) => service.updateRole(actorGrants, projectId, roleId, input)),
  deleteRole: (env, projectId, roleId) =>
    withService(env, (service) => service.deleteRole(projectId, roleId)),
  listMembers: (env, projectId) => withService(env, (service) => service.listMembers(projectId)),
  addMember: (env, actorGrants, projectId, userId, roleId) =>
    withService(env, (service) => service.addMember(actorGrants, projectId, userId, roleId)),
  replaceMemberRole: (env, actorGrants, projectId, memberId, roleId) =>
    withService(env, (service) =>
      service.replaceMemberRole(actorGrants, projectId, memberId, roleId),
    ),
  removeMember: (env, projectId, memberId) =>
    withService(env, (service) => service.removeMember(projectId, memberId)),
  listUsers: (env, page, pageSize) =>
    withService(env, (service) => service.listUsers(page, pageSize)),
};
