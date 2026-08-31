import { and, asc, count, eq, inArray, ne, sql } from "drizzle-orm";

import type { PacaDatabase } from "../database";
import {
  pacaSystemRolePermissions,
  pacaSystemRoles,
  pacaUserSystemRoles,
  user,
} from "../db/schema";
import type { PermissionResource } from "./statement";
import {
  type PersistedSystemRoleInput,
  type SystemRole,
  SystemRoleError,
  type SystemRoleRepository,
  systemRoleErrorCodes,
} from "./system-role-service";

const SYSTEM_ROLE_ADVISORY_LOCK = 1885432672;
const SUPER_ADMIN_ROLE_NAME = "SUPER_ADMIN";

type FlatSystemRoleRow = {
  id: string;
  name: string;
  description: string;
  isBuiltIn: boolean;
  createdAt: Date;
  updatedAt: Date;
  resource: string | null;
  action: string | null;
};

function hydrateRoles(rows: FlatSystemRoleRow[]): SystemRole[] {
  const roles = new Map<string, SystemRole>();
  for (const row of rows) {
    const role = roles.get(row.id) ?? {
      id: row.id,
      name: row.name,
      description: row.description,
      isBuiltIn: row.isBuiltIn,
      grants: [],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    if (row.resource && row.action) {
      role.grants.push({
        resource: row.resource as PermissionResource | "*",
        action: row.action,
      });
    }
    roles.set(row.id, role);
  }
  return [...roles.values()];
}

export class PostgresSystemRoleRepository implements SystemRoleRepository {
  constructor(private readonly database: PacaDatabase) {}

  async list(): Promise<SystemRole[]> {
    const rows = await this.database
      .select({
        id: pacaSystemRoles.id,
        name: pacaSystemRoles.name,
        description: pacaSystemRoles.description,
        isBuiltIn: pacaSystemRoles.isBuiltIn,
        createdAt: pacaSystemRoles.createdAt,
        updatedAt: pacaSystemRoles.updatedAt,
        resource: pacaSystemRolePermissions.resource,
        action: pacaSystemRolePermissions.action,
      })
      .from(pacaSystemRoles)
      .leftJoin(pacaSystemRolePermissions, eq(pacaSystemRoles.id, pacaSystemRolePermissions.roleId))
      .orderBy(asc(pacaSystemRoles.createdAt), asc(pacaSystemRoles.name));

    return hydrateRoles(rows);
  }

  async create(input: PersistedSystemRoleInput): Promise<SystemRole> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(${SYSTEM_ROLE_ADVISORY_LOCK})`);
      const [existing] = await transaction
        .select({ id: pacaSystemRoles.id })
        .from(pacaSystemRoles)
        .where(sql`lower(${pacaSystemRoles.name}) = lower(${input.name})`)
        .limit(1);
      if (existing) throw new SystemRoleError(systemRoleErrorCodes.nameTaken);

      const now = new Date();
      const [role] = await transaction
        .insert(pacaSystemRoles)
        .values({
          id: crypto.randomUUID(),
          name: input.name,
          description: input.description,
          isBuiltIn: false,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!role) throw new Error("SYSTEM_ROLE_CREATE_FAILED");

      if (input.grants.length > 0) {
        await transaction.insert(pacaSystemRolePermissions).values(
          input.grants.map((grant) => ({
            roleId: role.id,
            resource: grant.resource,
            action: grant.action,
          })),
        );
      }

      return { ...role, grants: [...input.grants] };
    });
  }

  async update(roleId: string, input: PersistedSystemRoleInput): Promise<SystemRole> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(${SYSTEM_ROLE_ADVISORY_LOCK})`);
      const [current] = await transaction
        .select()
        .from(pacaSystemRoles)
        .where(eq(pacaSystemRoles.id, roleId))
        .limit(1);
      if (!current) throw new SystemRoleError(systemRoleErrorCodes.notFound);
      if (current.isBuiltIn) throw new SystemRoleError(systemRoleErrorCodes.builtIn);

      const [nameConflict] = await transaction
        .select({ id: pacaSystemRoles.id })
        .from(pacaSystemRoles)
        .where(
          and(
            sql`lower(${pacaSystemRoles.name}) = lower(${input.name})`,
            ne(pacaSystemRoles.id, roleId),
          ),
        )
        .limit(1);
      if (nameConflict) throw new SystemRoleError(systemRoleErrorCodes.nameTaken);

      const [role] = await transaction
        .update(pacaSystemRoles)
        .set({
          name: input.name,
          description: input.description,
          updatedAt: new Date(),
        })
        .where(eq(pacaSystemRoles.id, roleId))
        .returning();
      if (!role) throw new SystemRoleError(systemRoleErrorCodes.notFound);

      await transaction
        .delete(pacaSystemRolePermissions)
        .where(eq(pacaSystemRolePermissions.roleId, roleId));
      if (input.grants.length > 0) {
        await transaction.insert(pacaSystemRolePermissions).values(
          input.grants.map((grant) => ({
            roleId,
            resource: grant.resource,
            action: grant.action,
          })),
        );
      }

      return { ...role, grants: [...input.grants] };
    });
  }

  async delete(roleId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(${SYSTEM_ROLE_ADVISORY_LOCK})`);
      const [role] = await transaction
        .select({ isBuiltIn: pacaSystemRoles.isBuiltIn })
        .from(pacaSystemRoles)
        .where(eq(pacaSystemRoles.id, roleId))
        .limit(1);
      if (!role) throw new SystemRoleError(systemRoleErrorCodes.notFound);
      if (role.isBuiltIn) throw new SystemRoleError(systemRoleErrorCodes.builtIn);

      const [assignments] = await transaction
        .select({ value: count() })
        .from(pacaUserSystemRoles)
        .where(eq(pacaUserSystemRoles.roleId, roleId));
      if (Number(assignments?.value ?? 0) > 0) {
        throw new SystemRoleError(systemRoleErrorCodes.assigned);
      }

      await transaction.delete(pacaSystemRoles).where(eq(pacaSystemRoles.id, roleId));
    });
  }

  async replaceUserRoles(
    userId: string,
    roleIds: readonly string[],
    assertAssignable: (roles: readonly SystemRole[]) => void,
  ): Promise<SystemRole[]> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(${SYSTEM_ROLE_ADVISORY_LOCK})`);

      const [targetUser] = await transaction
        .select({ id: user.id })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1);
      if (!targetUser) throw new SystemRoleError(systemRoleErrorCodes.userNotFound);

      const rows = await transaction
        .select({
          id: pacaSystemRoles.id,
          name: pacaSystemRoles.name,
          description: pacaSystemRoles.description,
          isBuiltIn: pacaSystemRoles.isBuiltIn,
          createdAt: pacaSystemRoles.createdAt,
          updatedAt: pacaSystemRoles.updatedAt,
          resource: pacaSystemRolePermissions.resource,
          action: pacaSystemRolePermissions.action,
        })
        .from(pacaSystemRoles)
        .leftJoin(
          pacaSystemRolePermissions,
          eq(pacaSystemRoles.id, pacaSystemRolePermissions.roleId),
        )
        .where(inArray(pacaSystemRoles.id, [...roleIds]))
        .orderBy(asc(pacaSystemRoles.name));
      const roles = hydrateRoles(rows);
      if (roles.length !== roleIds.length) {
        throw new SystemRoleError(systemRoleErrorCodes.notFound);
      }

      // Run the domain grant-ceiling assertion after acquiring the same lock
      // used by role mutation, so the checked grants cannot change before the
      // replacement is committed.
      assertAssignable(roles);

      const [superAdminRole] = await transaction
        .select({ id: pacaSystemRoles.id })
        .from(pacaSystemRoles)
        .where(
          and(eq(pacaSystemRoles.name, SUPER_ADMIN_ROLE_NAME), eq(pacaSystemRoles.isBuiltIn, true)),
        )
        .limit(1);
      if (!superAdminRole) throw new Error("SUPER_ADMIN_ROLE_NOT_SEEDED");

      const [currentSuperAdminAssignment] = await transaction
        .select({ roleId: pacaUserSystemRoles.roleId })
        .from(pacaUserSystemRoles)
        .where(
          and(
            eq(pacaUserSystemRoles.userId, userId),
            eq(pacaUserSystemRoles.roleId, superAdminRole.id),
          ),
        )
        .limit(1);
      if (currentSuperAdminAssignment && !roleIds.includes(superAdminRole.id)) {
        const [superAdminCount] = await transaction
          .select({ value: count() })
          .from(pacaUserSystemRoles)
          .where(eq(pacaUserSystemRoles.roleId, superAdminRole.id));
        if (Number(superAdminCount?.value ?? 0) <= 1) {
          throw new SystemRoleError(systemRoleErrorCodes.lastSuperAdmin);
        }
      }

      await transaction.delete(pacaUserSystemRoles).where(eq(pacaUserSystemRoles.userId, userId));
      await transaction.insert(pacaUserSystemRoles).values(
        roleIds.map((roleId) => ({
          userId,
          roleId,
        })),
      );

      return roles;
    });
  }
}
