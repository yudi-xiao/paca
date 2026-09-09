import type { AppBindings } from "../bindings";
import { withDatabase } from "../database";
import {
  listDelegatedAgentIds,
  projectEnvironmentConnectionRevoker,
  readProjectEnvironmentPermissionSnapshot,
  usersWithProjectEnvironmentPermissionLoss,
} from "../environment/project-permission-revocation";
import type { PermissionGrant } from "../permission/statement";
import { invalidateProjectActor, invalidateProjectRoom } from "../realtime/invalidation";
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
  updateRole: async (env, actorGrants, projectId, roleId, input) => {
    const { role, agentIds } = await withDatabase(env, async (database) => {
      const service = new ProjectAccessService(new PostgresProjectAccessRepository(database));
      const affectedUserIds = (await service.listMembers(projectId))
        .filter((member) => member.role.id === roleId)
        .map((member) => member.userId);
      const before = await readProjectEnvironmentPermissionSnapshot(
        database,
        projectId,
        affectedUserIds,
      );
      const role = await service.updateRole(actorGrants, projectId, roleId, input);
      const after = await readProjectEnvironmentPermissionSnapshot(
        database,
        projectId,
        affectedUserIds,
      );
      const agentIds = await listDelegatedAgentIds(
        database,
        usersWithProjectEnvironmentPermissionLoss(before, after),
      );
      return { role, agentIds };
    });
    await Promise.all([
      invalidateProjectRoom(env, projectId),
      projectEnvironmentConnectionRevoker(env).revoke(projectId, agentIds),
    ]);
    return role;
  },
  deleteRole: (env, projectId, roleId) =>
    withService(env, (service) => service.deleteRole(projectId, roleId)),
  listMembers: (env, projectId) => withService(env, (service) => service.listMembers(projectId)),
  addMember: (env, actorGrants, projectId, userId, roleId) =>
    withService(env, (service) => service.addMember(actorGrants, projectId, userId, roleId)),
  replaceMemberRole: async (env, actorGrants, projectId, memberId, roleId) => {
    const { member, agentIds } = await withDatabase(env, async (database) => {
      const service = new ProjectAccessService(new PostgresProjectAccessRepository(database));
      const current = (await service.listMembers(projectId)).find(
        (candidate) => candidate.id === memberId,
      );
      const affectedUserIds = current ? [current.userId] : [];
      const before = await readProjectEnvironmentPermissionSnapshot(
        database,
        projectId,
        affectedUserIds,
      );
      const member = await service.replaceMemberRole(actorGrants, projectId, memberId, roleId);
      const after = await readProjectEnvironmentPermissionSnapshot(
        database,
        projectId,
        affectedUserIds,
      );
      const agentIds = await listDelegatedAgentIds(
        database,
        usersWithProjectEnvironmentPermissionLoss(before, after),
      );
      return { member, agentIds };
    });
    await Promise.all([
      invalidateProjectActor(env, projectId, "user", member.userId),
      projectEnvironmentConnectionRevoker(env).revoke(projectId, agentIds),
    ]);
    return member;
  },
  removeMember: async (env, projectId, memberId) => {
    const { member, agentIds } = await withDatabase(env, async (database) => {
      const service = new ProjectAccessService(new PostgresProjectAccessRepository(database));
      const current = (await service.listMembers(projectId)).find(
        (candidate) => candidate.id === memberId,
      );
      const affectedUserIds = current ? [current.userId] : [];
      const before = await readProjectEnvironmentPermissionSnapshot(
        database,
        projectId,
        affectedUserIds,
      );
      const member = await service.removeMember(projectId, memberId);
      const after = await readProjectEnvironmentPermissionSnapshot(
        database,
        projectId,
        affectedUserIds,
      );
      const agentIds = await listDelegatedAgentIds(
        database,
        usersWithProjectEnvironmentPermissionLoss(before, after),
      );
      return { member, agentIds };
    });
    await Promise.all([
      invalidateProjectActor(env, projectId, "user", member.userId),
      projectEnvironmentConnectionRevoker(env).revoke(projectId, agentIds),
    ]);
  },
  listUsers: (env, page, pageSize) =>
    withService(env, (service) => service.listUsers(page, pageSize)),
};
