import { canDelegatePermissionGrants } from "../permission/evaluator";
import type { PermissionGrant } from "../permission/statement";
import { permissionGrantsFromLegacyMap } from "../permission/statement";

export const organizationAccessErrorCodes = {
  assignmentInvalid: "ORGANIZATION_ROLE_ASSIGNMENT_INVALID",
  memberNotFound: "ORGANIZATION_MEMBER_NOT_FOUND",
  lastOwner: "ORGANIZATION_MEMBER_LAST_OWNER",
  permissionsInvalid: "ROLE_PERMISSIONS_INVALID",
  permissionEscalation: "ROLE_PERMISSION_ESCALATION",
  roleAssigned: "ORGANIZATION_ROLE_HAS_MEMBERS",
  roleBuiltIn: "ORGANIZATION_ROLE_BUILT_IN",
  roleDescriptionInvalid: "ORGANIZATION_ROLE_DESCRIPTION_INVALID",
  roleNameInvalid: "ORGANIZATION_ROLE_NAME_INVALID",
  roleNameTaken: "ORGANIZATION_ROLE_NAME_TAKEN",
  roleNotFound: "ORGANIZATION_ROLE_NOT_FOUND",
} as const;

export type OrganizationAccessErrorCode =
  (typeof organizationAccessErrorCodes)[keyof typeof organizationAccessErrorCodes];

export class OrganizationAccessError extends Error {
  constructor(
    readonly code: OrganizationAccessErrorCode,
    message = code,
  ) {
    super(message);
    this.name = "OrganizationAccessError";
  }
}

export type OrganizationRole = {
  id: string;
  organizationId: string;
  name: string;
  description: string;
  isBuiltIn: boolean;
  grants: PermissionGrant[];
  createdAt: Date;
  updatedAt: Date;
};

export type OrganizationMember = {
  id: string;
  organizationId: string;
  userId: string;
  userName: string;
  userEmail: string;
  userImage: string | null;
  roles: OrganizationRole[];
  createdAt: Date;
};

export type OrganizationRoleInput = {
  name: string;
  description?: string;
  permissions: unknown;
};

export type PersistedOrganizationRoleInput = {
  name: string;
  description: string;
  grants: PermissionGrant[];
};

export interface OrganizationAccessRepository {
  listRoles(organizationId: string): Promise<OrganizationRole[]>;
  createRole(
    organizationId: string,
    input: PersistedOrganizationRoleInput,
  ): Promise<OrganizationRole>;
  updateRole(
    organizationId: string,
    roleId: string,
    input: PersistedOrganizationRoleInput,
  ): Promise<OrganizationRole>;
  deleteRole(organizationId: string, roleId: string): Promise<void>;
  listMembers(organizationId: string): Promise<OrganizationMember[]>;
  replaceMemberRoles(
    organizationId: string,
    memberId: string,
    roleIds: readonly string[],
    assertAssignable: (roles: readonly OrganizationRole[]) => void,
  ): Promise<OrganizationMember>;
}

function normalizeRoleInput(input: OrganizationRoleInput): PersistedOrganizationRoleInput {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 64) {
    throw new OrganizationAccessError(organizationAccessErrorCodes.roleNameInvalid);
  }

  const description = input.description?.trim() ?? "";
  if (description.length > 500) {
    throw new OrganizationAccessError(organizationAccessErrorCodes.roleDescriptionInvalid);
  }

  try {
    return {
      name,
      description,
      grants: permissionGrantsFromLegacyMap("organization", input.permissions),
    };
  } catch {
    throw new OrganizationAccessError(organizationAccessErrorCodes.permissionsInvalid);
  }
}

function requireDelegationCeiling(
  actorGrants: readonly PermissionGrant[],
  proposedGrants: readonly PermissionGrant[],
): void {
  if (!canDelegatePermissionGrants(actorGrants, proposedGrants)) {
    throw new OrganizationAccessError(organizationAccessErrorCodes.permissionEscalation);
  }
}

export class OrganizationAccessService {
  constructor(private readonly repository: OrganizationAccessRepository) {}

  listRoles(organizationId: string): Promise<OrganizationRole[]> {
    return this.repository.listRoles(organizationId);
  }

  async createRole(
    actorGrants: readonly PermissionGrant[],
    organizationId: string,
    input: OrganizationRoleInput,
  ): Promise<OrganizationRole> {
    const normalized = normalizeRoleInput(input);
    requireDelegationCeiling(actorGrants, normalized.grants);
    return await this.repository.createRole(organizationId, normalized);
  }

  async updateRole(
    actorGrants: readonly PermissionGrant[],
    organizationId: string,
    roleId: string,
    input: OrganizationRoleInput,
  ): Promise<OrganizationRole> {
    const normalized = normalizeRoleInput(input);
    requireDelegationCeiling(actorGrants, normalized.grants);
    return await this.repository.updateRole(organizationId, roleId, normalized);
  }

  deleteRole(organizationId: string, roleId: string): Promise<void> {
    return this.repository.deleteRole(organizationId, roleId);
  }

  listMembers(organizationId: string): Promise<OrganizationMember[]> {
    return this.repository.listMembers(organizationId);
  }

  async replaceMemberRoles(
    actorGrants: readonly PermissionGrant[],
    organizationId: string,
    memberId: string,
    roleIds: readonly string[],
  ): Promise<OrganizationMember> {
    const normalizedMemberId = memberId.trim();
    const normalizedRoleIds = [...new Set(roleIds.map((roleId) => roleId.trim()))];
    if (
      normalizedMemberId.length === 0 ||
      normalizedMemberId.length > 255 ||
      normalizedRoleIds.length === 0 ||
      normalizedRoleIds.length > 32 ||
      normalizedRoleIds.some((roleId) => roleId.length === 0)
    ) {
      throw new OrganizationAccessError(organizationAccessErrorCodes.assignmentInvalid);
    }

    return await this.repository.replaceMemberRoles(
      organizationId,
      normalizedMemberId,
      normalizedRoleIds,
      (roles) => {
        requireDelegationCeiling(
          actorGrants,
          roles.flatMap((role) => role.grants),
        );
      },
    );
  }
}
