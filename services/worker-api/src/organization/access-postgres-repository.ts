import { and, asc, count, countDistinct, eq, inArray, ne, sql } from "drizzle-orm";

import type { PacaDatabase } from "../database";
import {
  member as authMember,
  organization,
  pacaOrganizationMemberRoles,
  pacaOrganizationRolePermissions,
  pacaOrganizationRoles,
  user,
} from "../db/schema";
import type { PermissionResource } from "../permission/statement";
import {
  OrganizationAccessError,
  type OrganizationAccessRepository,
  type OrganizationMember,
  type OrganizationRole,
  organizationAccessErrorCodes,
  type PersistedOrganizationRoleInput,
} from "./access-service";

const ORGANIZATION_ACCESS_ADVISORY_LOCK = 1885432675;
const OWNER_ROLE_NAME = "OWNER";
type PacaTransaction = Parameters<Parameters<PacaDatabase["transaction"]>[0]>[0];

type FlatRoleRow = {
  id: string;
  organizationId: string;
  name: string;
  description: string;
  isBuiltIn: boolean;
  createdAt: Date;
  updatedAt: Date;
  resource: string | null;
  action: string | null;
};

function hydrateRoles(rows: FlatRoleRow[]): OrganizationRole[] {
  const roles = new Map<string, OrganizationRole>();
  for (const row of rows) {
    const role = roles.get(row.id) ?? {
      id: row.id,
      organizationId: row.organizationId,
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

export class PostgresOrganizationAccessRepository implements OrganizationAccessRepository {
  constructor(private readonly database: PacaDatabase) {}

  async listRoles(organizationId: string): Promise<OrganizationRole[]> {
    const rows = await this.database
      .select({
        id: pacaOrganizationRoles.id,
        organizationId: pacaOrganizationRoles.organizationId,
        name: pacaOrganizationRoles.name,
        description: pacaOrganizationRoles.description,
        isBuiltIn: pacaOrganizationRoles.isBuiltIn,
        createdAt: pacaOrganizationRoles.createdAt,
        updatedAt: pacaOrganizationRoles.updatedAt,
        resource: pacaOrganizationRolePermissions.resource,
        action: pacaOrganizationRolePermissions.action,
      })
      .from(pacaOrganizationRoles)
      .innerJoin(organization, eq(pacaOrganizationRoles.organizationId, organization.id))
      .leftJoin(
        pacaOrganizationRolePermissions,
        eq(pacaOrganizationRoles.id, pacaOrganizationRolePermissions.roleId),
      )
      .where(eq(pacaOrganizationRoles.organizationId, organizationId))
      .orderBy(asc(pacaOrganizationRoles.createdAt), asc(pacaOrganizationRoles.name));
    return hydrateRoles(rows);
  }

  async createRole(
    organizationId: string,
    input: PersistedOrganizationRoleInput,
  ): Promise<OrganizationRole> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(${ORGANIZATION_ACCESS_ADVISORY_LOCK})`,
      );
      await this.requireOrganization(transaction, organizationId);

      const [conflict] = await transaction
        .select({ id: pacaOrganizationRoles.id })
        .from(pacaOrganizationRoles)
        .where(
          and(
            eq(pacaOrganizationRoles.organizationId, organizationId),
            sql`lower(${pacaOrganizationRoles.name}) = lower(${input.name})`,
          ),
        )
        .limit(1);
      if (conflict) throw new OrganizationAccessError(organizationAccessErrorCodes.roleNameTaken);

      const [created] = await transaction
        .insert(pacaOrganizationRoles)
        .values({
          id: crypto.randomUUID(),
          organizationId,
          name: input.name,
          description: input.description,
          isBuiltIn: false,
        })
        .returning();
      if (!created) throw new Error("ORGANIZATION_ROLE_CREATE_FAILED");

      if (input.grants.length > 0) {
        await transaction.insert(pacaOrganizationRolePermissions).values(
          input.grants.map((grant) => ({
            roleId: created.id,
            resource: grant.resource,
            action: grant.action,
          })),
        );
      }
      return { ...created, grants: [...input.grants] };
    });
  }

  async updateRole(
    organizationId: string,
    roleId: string,
    input: PersistedOrganizationRoleInput,
  ): Promise<OrganizationRole> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(${ORGANIZATION_ACCESS_ADVISORY_LOCK})`,
      );
      await this.requireOrganization(transaction, organizationId);
      const [current] = await transaction
        .select()
        .from(pacaOrganizationRoles)
        .where(
          and(
            eq(pacaOrganizationRoles.id, roleId),
            eq(pacaOrganizationRoles.organizationId, organizationId),
          ),
        )
        .limit(1);
      if (!current) throw new OrganizationAccessError(organizationAccessErrorCodes.roleNotFound);
      if (current.isBuiltIn) {
        throw new OrganizationAccessError(organizationAccessErrorCodes.roleBuiltIn);
      }

      const [conflict] = await transaction
        .select({ id: pacaOrganizationRoles.id })
        .from(pacaOrganizationRoles)
        .where(
          and(
            eq(pacaOrganizationRoles.organizationId, organizationId),
            sql`lower(${pacaOrganizationRoles.name}) = lower(${input.name})`,
            ne(pacaOrganizationRoles.id, roleId),
          ),
        )
        .limit(1);
      if (conflict) throw new OrganizationAccessError(organizationAccessErrorCodes.roleNameTaken);

      const [updated] = await transaction
        .update(pacaOrganizationRoles)
        .set({ name: input.name, description: input.description, updatedAt: new Date() })
        .where(
          and(
            eq(pacaOrganizationRoles.id, roleId),
            eq(pacaOrganizationRoles.organizationId, organizationId),
          ),
        )
        .returning();
      if (!updated) throw new OrganizationAccessError(organizationAccessErrorCodes.roleNotFound);

      await transaction
        .delete(pacaOrganizationRolePermissions)
        .where(eq(pacaOrganizationRolePermissions.roleId, roleId));
      if (input.grants.length > 0) {
        await transaction.insert(pacaOrganizationRolePermissions).values(
          input.grants.map((grant) => ({
            roleId,
            resource: grant.resource,
            action: grant.action,
          })),
        );
      }
      return { ...updated, grants: [...input.grants] };
    });
  }

  async deleteRole(organizationId: string, roleId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(${ORGANIZATION_ACCESS_ADVISORY_LOCK})`,
      );
      await this.requireOrganization(transaction, organizationId);
      const [role] = await transaction
        .select({ isBuiltIn: pacaOrganizationRoles.isBuiltIn })
        .from(pacaOrganizationRoles)
        .where(
          and(
            eq(pacaOrganizationRoles.id, roleId),
            eq(pacaOrganizationRoles.organizationId, organizationId),
          ),
        )
        .limit(1);
      if (!role) throw new OrganizationAccessError(organizationAccessErrorCodes.roleNotFound);
      if (role.isBuiltIn) {
        throw new OrganizationAccessError(organizationAccessErrorCodes.roleBuiltIn);
      }

      const [assignment] = await transaction
        .select({ value: count() })
        .from(pacaOrganizationMemberRoles)
        .where(
          and(
            eq(pacaOrganizationMemberRoles.organizationId, organizationId),
            eq(pacaOrganizationMemberRoles.roleId, roleId),
          ),
        );
      if (Number(assignment?.value ?? 0) > 0) {
        throw new OrganizationAccessError(organizationAccessErrorCodes.roleAssigned);
      }
      await transaction
        .delete(pacaOrganizationRoles)
        .where(
          and(
            eq(pacaOrganizationRoles.id, roleId),
            eq(pacaOrganizationRoles.organizationId, organizationId),
          ),
        );
    });
  }

  async listMembers(organizationId: string): Promise<OrganizationMember[]> {
    const [memberRows, roles, assignmentRows] = await Promise.all([
      this.database
        .select({
          id: authMember.id,
          organizationId: authMember.organizationId,
          userId: authMember.userId,
          userName: user.name,
          userEmail: user.email,
          userImage: user.image,
          createdAt: authMember.createdAt,
        })
        .from(authMember)
        .innerJoin(user, eq(authMember.userId, user.id))
        .where(eq(authMember.organizationId, organizationId))
        .orderBy(asc(user.name), asc(user.email)),
      this.listRoles(organizationId),
      this.database
        .select({
          memberId: pacaOrganizationMemberRoles.memberId,
          roleId: pacaOrganizationMemberRoles.roleId,
        })
        .from(pacaOrganizationMemberRoles)
        .where(eq(pacaOrganizationMemberRoles.organizationId, organizationId)),
    ]);

    const rolesById = new Map(roles.map((role) => [role.id, role]));
    const roleIdsByMember = new Map<string, string[]>();
    for (const assignment of assignmentRows) {
      const roleIds = roleIdsByMember.get(assignment.memberId) ?? [];
      roleIds.push(assignment.roleId);
      roleIdsByMember.set(assignment.memberId, roleIds);
    }
    return memberRows.map((row) => ({
      ...row,
      roles: (roleIdsByMember.get(row.id) ?? [])
        .map((roleId) => rolesById.get(roleId))
        .filter((role): role is OrganizationRole => Boolean(role)),
    }));
  }

  async replaceMemberRoles(
    organizationId: string,
    memberId: string,
    roleIds: readonly string[],
    assertAssignable: (roles: readonly OrganizationRole[]) => void,
  ): Promise<OrganizationMember> {
    await this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(${ORGANIZATION_ACCESS_ADVISORY_LOCK})`,
      );
      await this.requireOrganization(transaction, organizationId);
      const [target] = await transaction
        .select({ id: authMember.id })
        .from(authMember)
        .where(and(eq(authMember.id, memberId), eq(authMember.organizationId, organizationId)))
        .limit(1);
      if (!target) throw new OrganizationAccessError(organizationAccessErrorCodes.memberNotFound);

      const roles = await this.readRoles(transaction, organizationId, roleIds);
      if (roles.length !== roleIds.length) {
        throw new OrganizationAccessError(organizationAccessErrorCodes.roleNotFound);
      }
      assertAssignable(roles);
      await this.requireOwnerRemains(transaction, organizationId, memberId, roleIds);

      await transaction
        .delete(pacaOrganizationMemberRoles)
        .where(
          and(
            eq(pacaOrganizationMemberRoles.memberId, memberId),
            eq(pacaOrganizationMemberRoles.organizationId, organizationId),
          ),
        );
      await transaction
        .insert(pacaOrganizationMemberRoles)
        .values(roleIds.map((roleId) => ({ memberId, roleId, organizationId })));
    });

    const result = (await this.listMembers(organizationId)).find((item) => item.id === memberId);
    if (!result) throw new OrganizationAccessError(organizationAccessErrorCodes.memberNotFound);
    return result;
  }

  private async requireOrganization(
    executor: PacaTransaction,
    organizationId: string,
  ): Promise<void> {
    const [row] = await executor
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1);
    if (!row) throw new OrganizationAccessError(organizationAccessErrorCodes.roleNotFound);
  }

  private async readRoles(
    executor: PacaTransaction,
    organizationId: string,
    roleIds: readonly string[],
  ): Promise<OrganizationRole[]> {
    const rows = await executor
      .select({
        id: pacaOrganizationRoles.id,
        organizationId: pacaOrganizationRoles.organizationId,
        name: pacaOrganizationRoles.name,
        description: pacaOrganizationRoles.description,
        isBuiltIn: pacaOrganizationRoles.isBuiltIn,
        createdAt: pacaOrganizationRoles.createdAt,
        updatedAt: pacaOrganizationRoles.updatedAt,
        resource: pacaOrganizationRolePermissions.resource,
        action: pacaOrganizationRolePermissions.action,
      })
      .from(pacaOrganizationRoles)
      .leftJoin(
        pacaOrganizationRolePermissions,
        eq(pacaOrganizationRoles.id, pacaOrganizationRolePermissions.roleId),
      )
      .where(
        and(
          eq(pacaOrganizationRoles.organizationId, organizationId),
          inArray(pacaOrganizationRoles.id, [...roleIds]),
        ),
      )
      .orderBy(asc(pacaOrganizationRoles.name));
    return hydrateRoles(rows);
  }

  private async requireOwnerRemains(
    executor: PacaTransaction,
    organizationId: string,
    memberId: string,
    replacementRoleIds: readonly string[],
  ): Promise<void> {
    const [ownerRole] = await executor
      .select({ id: pacaOrganizationRoles.id })
      .from(pacaOrganizationRoles)
      .where(
        and(
          eq(pacaOrganizationRoles.organizationId, organizationId),
          eq(pacaOrganizationRoles.name, OWNER_ROLE_NAME),
          eq(pacaOrganizationRoles.isBuiltIn, true),
        ),
      )
      .limit(1);
    if (!ownerRole) throw new Error("ORGANIZATION_OWNER_ROLE_NOT_SEEDED");
    if (replacementRoleIds.includes(ownerRole.id)) return;

    const [targetIsOwner] = await executor
      .select({ roleId: pacaOrganizationMemberRoles.roleId })
      .from(pacaOrganizationMemberRoles)
      .where(
        and(
          eq(pacaOrganizationMemberRoles.organizationId, organizationId),
          eq(pacaOrganizationMemberRoles.memberId, memberId),
          eq(pacaOrganizationMemberRoles.roleId, ownerRole.id),
        ),
      )
      .limit(1);
    if (!targetIsOwner) return;

    const [ownerCount] = await executor
      .select({ value: countDistinct(pacaOrganizationMemberRoles.memberId) })
      .from(pacaOrganizationMemberRoles)
      .where(
        and(
          eq(pacaOrganizationMemberRoles.organizationId, organizationId),
          eq(pacaOrganizationMemberRoles.roleId, ownerRole.id),
        ),
      );
    if (Number(ownerCount?.value ?? 0) <= 1) {
      throw new OrganizationAccessError(organizationAccessErrorCodes.lastOwner);
    }
  }
}
