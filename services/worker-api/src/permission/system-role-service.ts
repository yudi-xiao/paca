import { canDelegatePermissionGrants } from "./evaluator";
import type { PermissionGrant } from "./statement";
import { permissionGrantsFromLegacyMap } from "./statement";

export const systemRoleErrorCodes = {
  assigned: "GLOBAL_ROLE_HAS_ASSIGNED_USERS",
  assignmentInvalid: "GLOBAL_ROLE_ASSIGNMENT_INVALID",
  builtIn: "GLOBAL_ROLE_BUILT_IN",
  descriptionInvalid: "GLOBAL_ROLE_DESCRIPTION_INVALID",
  nameInvalid: "GLOBAL_ROLE_NAME_INVALID",
  nameTaken: "GLOBAL_ROLE_NAME_TAKEN",
  notFound: "GLOBAL_ROLE_NOT_FOUND",
  lastSuperAdmin: "GLOBAL_ROLE_LAST_SUPER_ADMIN",
  permissionEscalation: "ROLE_PERMISSION_ESCALATION",
  permissionsInvalid: "ROLE_PERMISSIONS_INVALID",
  userNotFound: "USER_NOT_FOUND",
} as const;

export type SystemRoleErrorCode = (typeof systemRoleErrorCodes)[keyof typeof systemRoleErrorCodes];

export class SystemRoleError extends Error {
  constructor(
    readonly code: SystemRoleErrorCode,
    message = code,
  ) {
    super(message);
    this.name = "SystemRoleError";
  }
}

export type SystemRole = {
  id: string;
  name: string;
  description: string;
  isBuiltIn: boolean;
  grants: PermissionGrant[];
  createdAt: Date;
  updatedAt: Date;
};

export type SystemRoleInput = {
  name: string;
  description?: string;
  permissions: unknown;
};

export type PersistedSystemRoleInput = {
  name: string;
  description: string;
  grants: PermissionGrant[];
};

export interface SystemRoleRepository {
  list(): Promise<SystemRole[]>;
  create(input: PersistedSystemRoleInput): Promise<SystemRole>;
  update(roleId: string, input: PersistedSystemRoleInput): Promise<SystemRole>;
  delete(roleId: string): Promise<void>;
  replaceUserRoles(
    userId: string,
    roleIds: readonly string[],
    assertAssignable: (roles: readonly SystemRole[]) => void,
  ): Promise<SystemRole[]>;
}

function normalizeRoleInput(input: SystemRoleInput): PersistedSystemRoleInput {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 64) {
    throw new SystemRoleError(systemRoleErrorCodes.nameInvalid);
  }

  const description = input.description?.trim() ?? "";
  if (description.length > 500) {
    throw new SystemRoleError(systemRoleErrorCodes.descriptionInvalid);
  }

  try {
    return {
      name,
      description,
      grants: permissionGrantsFromLegacyMap("systemRole", input.permissions),
    };
  } catch {
    throw new SystemRoleError(systemRoleErrorCodes.permissionsInvalid);
  }
}

function requireDelegationCeiling(
  actorGrants: readonly PermissionGrant[],
  proposedGrants: readonly PermissionGrant[],
): void {
  if (!canDelegatePermissionGrants(actorGrants, proposedGrants)) {
    throw new SystemRoleError(systemRoleErrorCodes.permissionEscalation);
  }
}

export class SystemRoleService {
  constructor(private readonly repository: SystemRoleRepository) {}

  list(): Promise<SystemRole[]> {
    return this.repository.list();
  }

  async create(
    actorGrants: readonly PermissionGrant[],
    input: SystemRoleInput,
  ): Promise<SystemRole> {
    const normalized = normalizeRoleInput(input);
    requireDelegationCeiling(actorGrants, normalized.grants);
    return await this.repository.create(normalized);
  }

  async update(
    actorGrants: readonly PermissionGrant[],
    roleId: string,
    input: SystemRoleInput,
  ): Promise<SystemRole> {
    const normalized = normalizeRoleInput(input);
    requireDelegationCeiling(actorGrants, normalized.grants);
    return await this.repository.update(roleId, normalized);
  }

  delete(roleId: string): Promise<void> {
    return this.repository.delete(roleId);
  }

  async replaceUserRoles(
    actorGrants: readonly PermissionGrant[],
    userId: string,
    roleIds: readonly string[],
  ): Promise<SystemRole[]> {
    const normalizedUserId = userId.trim();
    const normalizedRoleIds = [...new Set(roleIds.map((roleId) => roleId.trim()))];
    if (
      normalizedUserId.length === 0 ||
      normalizedUserId.length > 255 ||
      normalizedRoleIds.length === 0 ||
      normalizedRoleIds.length > 32 ||
      normalizedRoleIds.some((roleId) => roleId.length === 0)
    ) {
      throw new SystemRoleError(systemRoleErrorCodes.assignmentInvalid);
    }

    return await this.repository.replaceUserRoles(normalizedUserId, normalizedRoleIds, (roles) => {
      requireDelegationCeiling(
        actorGrants,
        roles.flatMap((role) => role.grants),
      );
    });
  }
}
