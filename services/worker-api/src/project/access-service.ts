import { canDelegatePermissionGrants } from "../permission/evaluator";
import type { PermissionGrant } from "../permission/statement";
import {
  permissionGrantsFromLegacyMap,
  permissionGrantsToLegacyMap,
} from "../permission/statement";

export const projectAccessErrorCodes = {
  roleAssigned: "PROJECT_ROLE_HAS_MEMBERS",
  roleBuiltIn: "PROJECT_ROLE_BUILT_IN",
  roleNameInvalid: "PROJECT_ROLE_NAME_INVALID",
  roleNameTaken: "PROJECT_ROLE_NAME_TAKEN",
  roleNotFound: "PROJECT_ROLE_NOT_FOUND",
  permissionsInvalid: "ROLE_PERMISSIONS_INVALID",
  permissionEscalation: "ROLE_PERMISSION_ESCALATION",
  memberAlreadyAdded: "PROJECT_MEMBER_ALREADY_ADDED",
  memberNotFound: "PROJECT_MEMBER_NOT_FOUND",
  lastAdmin: "PROJECT_MEMBER_LAST_ADMIN",
  userNotFound: "USER_NOT_FOUND",
} as const;

export type ProjectAccessErrorCode =
  (typeof projectAccessErrorCodes)[keyof typeof projectAccessErrorCodes];

export class ProjectAccessError extends Error {
  constructor(
    readonly code: ProjectAccessErrorCode,
    message = code,
  ) {
    super(message);
    this.name = "ProjectAccessError";
  }
}

export type ProjectRole = {
  id: string;
  projectId: string;
  name: string;
  description: string;
  isBuiltIn: boolean;
  grants: PermissionGrant[];
  createdAt: Date;
  updatedAt: Date;
};

export type ProjectMember = {
  id: string;
  projectId: string;
  userId: string;
  userName: string;
  userEmail: string;
  userImage: string | null;
  role: ProjectRole;
  createdAt: Date;
};

export type DirectoryUser = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  createdAt: Date;
};

export type DirectoryUserList = {
  items: DirectoryUser[];
  total: number;
  page: number;
  pageSize: number;
};

export type ProjectRoleInput = {
  name: string;
  description?: string;
  permissions: unknown;
};

export type PersistedProjectRoleInput = {
  name: string;
  description: string;
  grants: PermissionGrant[];
};

export interface ProjectAccessRepository {
  listRoles(projectId: string): Promise<ProjectRole[]>;
  createRole(projectId: string, input: PersistedProjectRoleInput): Promise<ProjectRole>;
  updateRole(
    projectId: string,
    roleId: string,
    input: PersistedProjectRoleInput,
  ): Promise<ProjectRole>;
  deleteRole(projectId: string, roleId: string): Promise<void>;
  listMembers(projectId: string): Promise<ProjectMember[]>;
  addMember(
    projectId: string,
    userId: string,
    roleId: string,
    assertAssignable: (role: ProjectRole) => void,
  ): Promise<ProjectMember>;
  replaceMemberRole(
    projectId: string,
    memberId: string,
    roleId: string,
    assertAssignable: (role: ProjectRole) => void,
  ): Promise<ProjectMember>;
  removeMember(projectId: string, memberId: string): Promise<void>;
  listUsers(page: number, pageSize: number): Promise<DirectoryUserList>;
}

function normalizeRoleInput(input: ProjectRoleInput): PersistedProjectRoleInput {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 64) {
    throw new ProjectAccessError(projectAccessErrorCodes.roleNameInvalid);
  }

  const description = input.description?.trim() ?? "";
  if (description.length > 500) {
    throw new ProjectAccessError(projectAccessErrorCodes.roleNameInvalid);
  }

  try {
    return {
      name,
      description,
      grants: permissionGrantsFromLegacyMap("project", input.permissions),
    };
  } catch {
    throw new ProjectAccessError(projectAccessErrorCodes.permissionsInvalid);
  }
}

function requireDelegationCeiling(
  actorGrants: readonly PermissionGrant[],
  proposedGrants: readonly PermissionGrant[],
): void {
  if (!canDelegatePermissionGrants(actorGrants, proposedGrants)) {
    throw new ProjectAccessError(projectAccessErrorCodes.permissionEscalation);
  }
}

export class ProjectAccessService {
  constructor(private readonly repository: ProjectAccessRepository) {}

  listRoles(projectId: string): Promise<ProjectRole[]> {
    return this.repository.listRoles(projectId);
  }

  async createRole(
    actorGrants: readonly PermissionGrant[],
    projectId: string,
    input: ProjectRoleInput,
  ): Promise<ProjectRole> {
    const normalized = normalizeRoleInput(input);
    requireDelegationCeiling(actorGrants, normalized.grants);
    return await this.repository.createRole(projectId, normalized);
  }

  async updateRole(
    actorGrants: readonly PermissionGrant[],
    projectId: string,
    roleId: string,
    input: ProjectRoleInput,
  ): Promise<ProjectRole> {
    const normalized = normalizeRoleInput(input);
    requireDelegationCeiling(actorGrants, normalized.grants);
    return await this.repository.updateRole(projectId, roleId, normalized);
  }

  deleteRole(projectId: string, roleId: string): Promise<void> {
    return this.repository.deleteRole(projectId, roleId);
  }

  listMembers(projectId: string): Promise<ProjectMember[]> {
    return this.repository.listMembers(projectId);
  }

  addMember(
    actorGrants: readonly PermissionGrant[],
    projectId: string,
    userId: string,
    roleId: string,
  ): Promise<ProjectMember> {
    return this.repository.addMember(projectId, userId, roleId, (role) => {
      requireDelegationCeiling(actorGrants, role.grants);
    });
  }

  replaceMemberRole(
    actorGrants: readonly PermissionGrant[],
    projectId: string,
    memberId: string,
    roleId: string,
  ): Promise<ProjectMember> {
    return this.repository.replaceMemberRole(projectId, memberId, roleId, (role) => {
      requireDelegationCeiling(actorGrants, role.grants);
    });
  }

  removeMember(projectId: string, memberId: string): Promise<void> {
    return this.repository.removeMember(projectId, memberId);
  }

  listUsers(page: number, pageSize: number): Promise<DirectoryUserList> {
    const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
    const normalizedPageSize = Number.isInteger(pageSize)
      ? Math.min(Math.max(pageSize, 1), 100)
      : 20;
    return this.repository.listUsers(normalizedPage, normalizedPageSize);
  }
}

export function projectRolePermissions(role: ProjectRole): Record<string, boolean> {
  return permissionGrantsToLegacyMap(role.grants);
}
