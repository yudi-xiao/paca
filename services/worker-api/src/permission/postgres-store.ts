import { and, count, eq, sql } from "drizzle-orm";

import type { PacaDatabase } from "../database";
import {
  member,
  organization,
  pacaOrganizationMemberRoles,
  pacaOrganizationRolePermissions,
  pacaOrganizationRoles,
  pacaProjectMemberRoles,
  pacaProjectMembers,
  pacaProjects,
  pacaRolePermissions,
  pacaSystemRolePermissions,
  pacaSystemRoles,
  pacaUserSystemRoles,
  session,
} from "../db/schema";
import type { PacaPermissionStore } from "./service";
import type { PermissionGrant, PermissionResource } from "./statement";

export const DEFAULT_ORGANIZATION_ID = "paca-default";
export const DEFAULT_ORGANIZATION_SLUG = "paca";

const SYSTEM_ROLE_NAMES = {
  owner: "SUPER_ADMIN",
  member: "USER",
} as const;

const ORGANIZATION_ROLE_NAMES = {
  owner: "OWNER",
  member: "MEMBER",
} as const;

function permissionRows(rows: Array<{ resource: string; action: string }>): PermissionGrant[] {
  return rows.map(({ resource, action }) => ({
    resource: resource as PermissionResource | "*",
    action,
  }));
}

export class PostgresPacaPermissionStore implements PacaPermissionStore {
  constructor(private readonly database: PacaDatabase) {}

  async listSystemGrants(userId: string): Promise<PermissionGrant[]> {
    const rows = await this.database
      .select({
        resource: pacaSystemRolePermissions.resource,
        action: pacaSystemRolePermissions.action,
      })
      .from(pacaUserSystemRoles)
      .innerJoin(pacaSystemRoles, eq(pacaUserSystemRoles.roleId, pacaSystemRoles.id))
      .innerJoin(
        pacaSystemRolePermissions,
        eq(pacaSystemRoles.id, pacaSystemRolePermissions.roleId),
      )
      .where(eq(pacaUserSystemRoles.userId, userId));

    return permissionRows(rows);
  }

  async listOrganizationGrants(userId: string, organizationId: string): Promise<PermissionGrant[]> {
    const rows = await this.database
      .select({
        resource: pacaOrganizationRolePermissions.resource,
        action: pacaOrganizationRolePermissions.action,
      })
      .from(member)
      .innerJoin(
        pacaOrganizationMemberRoles,
        and(
          eq(member.id, pacaOrganizationMemberRoles.memberId),
          eq(member.organizationId, pacaOrganizationMemberRoles.organizationId),
        ),
      )
      .innerJoin(
        pacaOrganizationRoles,
        and(
          eq(pacaOrganizationMemberRoles.roleId, pacaOrganizationRoles.id),
          eq(pacaOrganizationMemberRoles.organizationId, pacaOrganizationRoles.organizationId),
        ),
      )
      .innerJoin(
        pacaOrganizationRolePermissions,
        eq(pacaOrganizationRoles.id, pacaOrganizationRolePermissions.roleId),
      )
      .where(and(eq(member.userId, userId), eq(member.organizationId, organizationId)));

    return permissionRows(rows);
  }

  async listProjectGrants(userId: string, projectId: string): Promise<PermissionGrant[]> {
    const rows = await this.database
      .select({
        resource: pacaRolePermissions.resource,
        action: pacaRolePermissions.action,
      })
      .from(pacaProjectMembers)
      .innerJoin(
        pacaProjectMemberRoles,
        and(
          eq(pacaProjectMembers.id, pacaProjectMemberRoles.memberId),
          eq(pacaProjectMembers.projectId, pacaProjectMemberRoles.projectId),
        ),
      )
      .innerJoin(pacaRolePermissions, eq(pacaProjectMemberRoles.roleId, pacaRolePermissions.roleId))
      .where(
        and(eq(pacaProjectMembers.userId, userId), eq(pacaProjectMembers.projectId, projectId)),
      );

    return permissionRows(rows);
  }

  async organizationExists(organizationId: string): Promise<boolean> {
    const [row] = await this.database
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1);
    return Boolean(row);
  }

  async findProjectOrganization(projectId: string): Promise<string | null> {
    const [project] = await this.database
      .select({ organizationId: pacaProjects.organizationId })
      .from(pacaProjects)
      .where(and(eq(pacaProjects.id, projectId), eq(pacaProjects.status, "active")))
      .limit(1);
    return project?.organizationId ?? null;
  }

  async provisionDefaultOrganizationUser(userId: string, sessionToken?: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(1885432671)`);

      await transaction
        .insert(organization)
        .values({
          id: DEFAULT_ORGANIZATION_ID,
          name: "Paca",
          slug: DEFAULT_ORGANIZATION_SLUG,
          createdAt: new Date(),
        })
        .onConflictDoNothing({ target: organization.id });

      const [existingSystemRole] = await transaction
        .select({ name: pacaSystemRoles.name })
        .from(pacaUserSystemRoles)
        .innerJoin(pacaSystemRoles, eq(pacaUserSystemRoles.roleId, pacaSystemRoles.id))
        .where(eq(pacaUserSystemRoles.userId, userId))
        .limit(1);

      const [assignmentCount] = existingSystemRole
        ? [{ value: 1 }]
        : await transaction.select({ value: count() }).from(pacaUserSystemRoles);
      const bootstrapKind = existingSystemRole
        ? existingSystemRole.name === SYSTEM_ROLE_NAMES.owner
          ? "owner"
          : "member"
        : Number(assignmentCount?.value ?? 0) === 0
          ? "owner"
          : "member";

      if (!existingSystemRole) {
        const [systemRole] = await transaction
          .select({ id: pacaSystemRoles.id })
          .from(pacaSystemRoles)
          .where(eq(pacaSystemRoles.name, SYSTEM_ROLE_NAMES[bootstrapKind]))
          .limit(1);
        if (!systemRole) throw new Error("PACA_SYSTEM_ROLE_NOT_SEEDED");

        await transaction
          .insert(pacaUserSystemRoles)
          .values({ userId, roleId: systemRole.id })
          .onConflictDoNothing();
      }

      await transaction
        .insert(member)
        .values({
          id: crypto.randomUUID(),
          organizationId: DEFAULT_ORGANIZATION_ID,
          userId,
          role: bootstrapKind,
          createdAt: new Date(),
        })
        .onConflictDoNothing({ target: [member.organizationId, member.userId] });

      const [organizationMember] = await transaction
        .select({ id: member.id })
        .from(member)
        .where(and(eq(member.organizationId, DEFAULT_ORGANIZATION_ID), eq(member.userId, userId)))
        .limit(1);
      if (!organizationMember) throw new Error("PACA_ORGANIZATION_MEMBER_NOT_CREATED");

      const [organizationRole] = await transaction
        .select({ id: pacaOrganizationRoles.id })
        .from(pacaOrganizationRoles)
        .where(
          and(
            eq(pacaOrganizationRoles.organizationId, DEFAULT_ORGANIZATION_ID),
            eq(pacaOrganizationRoles.name, ORGANIZATION_ROLE_NAMES[bootstrapKind]),
          ),
        )
        .limit(1);
      if (!organizationRole) throw new Error("PACA_ORGANIZATION_ROLE_NOT_SEEDED");

      await transaction
        .insert(pacaOrganizationMemberRoles)
        .values({
          memberId: organizationMember.id,
          roleId: organizationRole.id,
          organizationId: DEFAULT_ORGANIZATION_ID,
        })
        .onConflictDoNothing();

      if (sessionToken) {
        await transaction
          .update(session)
          .set({ activeOrganizationId: DEFAULT_ORGANIZATION_ID })
          .where(eq(session.token, sessionToken));
      }
    });
  }
}
