import { and, asc, count, countDistinct, eq, ne, sql } from "drizzle-orm";

import type { PacaDatabase } from "../database";
import {
  pacaProjectMemberRoles,
  pacaProjectMembers,
  pacaProjectRoles,
  pacaProjects,
  pacaRolePermissions,
  user,
} from "../db/schema";
import type { PermissionResource } from "../permission/statement";
import {
  type DirectoryUserList,
  type PersistedProjectRoleInput,
  ProjectAccessError,
  type ProjectAccessRepository,
  type ProjectMember,
  type ProjectRole,
  projectAccessErrorCodes,
} from "./access-service";

const PROJECT_ACCESS_ADVISORY_LOCK = 1885432674;
const ADMIN_ROLE_NAME = "Admin";
type PacaTransaction = Parameters<Parameters<PacaDatabase["transaction"]>[0]>[0];

type FlatRoleRow = {
  id: string;
  projectId: string;
  name: string;
  description: string;
  isBuiltIn: boolean;
  createdAt: Date;
  updatedAt: Date;
  resource: string | null;
  action: string | null;
};

function hydrateRoles(rows: FlatRoleRow[]): ProjectRole[] {
  const roles = new Map<string, ProjectRole>();
  for (const row of rows) {
    const role = roles.get(row.id) ?? {
      id: row.id,
      projectId: row.projectId,
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

export class PostgresProjectAccessRepository implements ProjectAccessRepository {
  constructor(private readonly database: PacaDatabase) {}

  async listRoles(projectId: string): Promise<ProjectRole[]> {
    const rows = await this.database
      .select({
        id: pacaProjectRoles.id,
        projectId: pacaProjectRoles.projectId,
        name: pacaProjectRoles.name,
        description: pacaProjectRoles.description,
        isBuiltIn: pacaProjectRoles.isBuiltIn,
        createdAt: pacaProjectRoles.createdAt,
        updatedAt: pacaProjectRoles.updatedAt,
        resource: pacaRolePermissions.resource,
        action: pacaRolePermissions.action,
      })
      .from(pacaProjectRoles)
      .innerJoin(
        pacaProjects,
        and(eq(pacaProjectRoles.projectId, pacaProjects.id), eq(pacaProjects.status, "active")),
      )
      .leftJoin(pacaRolePermissions, eq(pacaProjectRoles.id, pacaRolePermissions.roleId))
      .where(eq(pacaProjectRoles.projectId, projectId))
      .orderBy(asc(pacaProjectRoles.createdAt), asc(pacaProjectRoles.name));
    return hydrateRoles(rows);
  }

  async createRole(projectId: string, input: PersistedProjectRoleInput): Promise<ProjectRole> {
    const role = await this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(${PROJECT_ACCESS_ADVISORY_LOCK})`);
      await this.requireActiveProject(transaction, projectId);

      const [conflict] = await transaction
        .select({ id: pacaProjectRoles.id })
        .from(pacaProjectRoles)
        .where(
          and(
            eq(pacaProjectRoles.projectId, projectId),
            sql`lower(${pacaProjectRoles.name}) = lower(${input.name})`,
          ),
        )
        .limit(1);
      if (conflict) throw new ProjectAccessError(projectAccessErrorCodes.roleNameTaken);

      const [created] = await transaction
        .insert(pacaProjectRoles)
        .values({
          id: crypto.randomUUID(),
          projectId,
          name: input.name,
          description: input.description,
          isBuiltIn: false,
        })
        .returning();
      if (!created) throw new Error("PROJECT_ROLE_CREATE_FAILED");
      if (input.grants.length > 0) {
        await transaction.insert(pacaRolePermissions).values(
          input.grants.map((grant) => ({
            roleId: created.id,
            resource: grant.resource,
            action: grant.action,
          })),
        );
      }
      return { ...created, grants: [...input.grants] };
    });
    return role;
  }

  async updateRole(
    projectId: string,
    roleId: string,
    input: PersistedProjectRoleInput,
  ): Promise<ProjectRole> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(${PROJECT_ACCESS_ADVISORY_LOCK})`);
      await this.requireActiveProject(transaction, projectId);

      const [current] = await transaction
        .select()
        .from(pacaProjectRoles)
        .where(and(eq(pacaProjectRoles.id, roleId), eq(pacaProjectRoles.projectId, projectId)))
        .limit(1);
      if (!current) throw new ProjectAccessError(projectAccessErrorCodes.roleNotFound);
      if (current.isBuiltIn) throw new ProjectAccessError(projectAccessErrorCodes.roleBuiltIn);

      const [conflict] = await transaction
        .select({ id: pacaProjectRoles.id })
        .from(pacaProjectRoles)
        .where(
          and(
            eq(pacaProjectRoles.projectId, projectId),
            sql`lower(${pacaProjectRoles.name}) = lower(${input.name})`,
            ne(pacaProjectRoles.id, roleId),
          ),
        )
        .limit(1);
      if (conflict) throw new ProjectAccessError(projectAccessErrorCodes.roleNameTaken);

      const [updated] = await transaction
        .update(pacaProjectRoles)
        .set({ name: input.name, description: input.description, updatedAt: new Date() })
        .where(and(eq(pacaProjectRoles.id, roleId), eq(pacaProjectRoles.projectId, projectId)))
        .returning();
      if (!updated) throw new ProjectAccessError(projectAccessErrorCodes.roleNotFound);

      await transaction.delete(pacaRolePermissions).where(eq(pacaRolePermissions.roleId, roleId));
      if (input.grants.length > 0) {
        await transaction.insert(pacaRolePermissions).values(
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

  async deleteRole(projectId: string, roleId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(${PROJECT_ACCESS_ADVISORY_LOCK})`);
      await this.requireActiveProject(transaction, projectId);
      const [role] = await transaction
        .select({ isBuiltIn: pacaProjectRoles.isBuiltIn })
        .from(pacaProjectRoles)
        .where(and(eq(pacaProjectRoles.id, roleId), eq(pacaProjectRoles.projectId, projectId)))
        .limit(1);
      if (!role) throw new ProjectAccessError(projectAccessErrorCodes.roleNotFound);
      if (role.isBuiltIn) throw new ProjectAccessError(projectAccessErrorCodes.roleBuiltIn);

      const [assignments] = await transaction
        .select({ value: count() })
        .from(pacaProjectMemberRoles)
        .where(
          and(
            eq(pacaProjectMemberRoles.projectId, projectId),
            eq(pacaProjectMemberRoles.roleId, roleId),
          ),
        );
      if (Number(assignments?.value ?? 0) > 0) {
        throw new ProjectAccessError(projectAccessErrorCodes.roleAssigned);
      }
      await transaction
        .delete(pacaProjectRoles)
        .where(and(eq(pacaProjectRoles.id, roleId), eq(pacaProjectRoles.projectId, projectId)));
    });
  }

  async listMembers(projectId: string): Promise<ProjectMember[]> {
    const rows = await this.database
      .select({
        memberId: pacaProjectMembers.id,
        projectId: pacaProjectMembers.projectId,
        userId: pacaProjectMembers.userId,
        memberCreatedAt: pacaProjectMembers.createdAt,
        userName: user.name,
        userEmail: user.email,
        userImage: user.image,
        roleId: pacaProjectRoles.id,
        roleName: pacaProjectRoles.name,
        roleDescription: pacaProjectRoles.description,
        roleIsBuiltIn: pacaProjectRoles.isBuiltIn,
        roleCreatedAt: pacaProjectRoles.createdAt,
        roleUpdatedAt: pacaProjectRoles.updatedAt,
        resource: pacaRolePermissions.resource,
        action: pacaRolePermissions.action,
      })
      .from(pacaProjectMembers)
      .innerJoin(
        pacaProjects,
        and(eq(pacaProjectMembers.projectId, pacaProjects.id), eq(pacaProjects.status, "active")),
      )
      .innerJoin(user, eq(pacaProjectMembers.userId, user.id))
      .innerJoin(
        pacaProjectMemberRoles,
        and(
          eq(pacaProjectMembers.id, pacaProjectMemberRoles.memberId),
          eq(pacaProjectMembers.projectId, pacaProjectMemberRoles.projectId),
        ),
      )
      .innerJoin(pacaProjectRoles, eq(pacaProjectMemberRoles.roleId, pacaProjectRoles.id))
      .leftJoin(pacaRolePermissions, eq(pacaProjectRoles.id, pacaRolePermissions.roleId))
      .where(eq(pacaProjectMembers.projectId, projectId))
      .orderBy(asc(user.name), asc(pacaProjectRoles.createdAt));

    const members = new Map<string, ProjectMember>();
    for (const row of rows) {
      const existing = members.get(row.memberId);
      if (existing) {
        if (existing.role.id === row.roleId && row.resource && row.action) {
          existing.role.grants.push({
            resource: row.resource as PermissionResource | "*",
            action: row.action,
          });
        }
        continue;
      }
      members.set(row.memberId, {
        id: row.memberId,
        projectId: row.projectId,
        userId: row.userId,
        userName: row.userName,
        userEmail: row.userEmail,
        userImage: row.userImage,
        createdAt: row.memberCreatedAt,
        role: {
          id: row.roleId,
          projectId: row.projectId,
          name: row.roleName,
          description: row.roleDescription,
          isBuiltIn: row.roleIsBuiltIn,
          grants:
            row.resource && row.action
              ? [
                  {
                    resource: row.resource as PermissionResource | "*",
                    action: row.action,
                  },
                ]
              : [],
          createdAt: row.roleCreatedAt,
          updatedAt: row.roleUpdatedAt,
        },
      });
    }
    return [...members.values()];
  }

  async addMember(
    projectId: string,
    userId: string,
    roleId: string,
    assertAssignable: (role: ProjectRole) => void,
  ): Promise<ProjectMember> {
    const memberId = await this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(${PROJECT_ACCESS_ADVISORY_LOCK})`);
      await this.requireActiveProject(transaction, projectId);

      const [targetUser] = await transaction
        .select({ id: user.id })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1);
      if (!targetUser) throw new ProjectAccessError(projectAccessErrorCodes.userNotFound);

      const role = await this.readRole(transaction, projectId, roleId);
      assertAssignable(role);

      const [existing] = await transaction
        .select({ id: pacaProjectMembers.id })
        .from(pacaProjectMembers)
        .where(
          and(eq(pacaProjectMembers.projectId, projectId), eq(pacaProjectMembers.userId, userId)),
        )
        .limit(1);
      if (existing) throw new ProjectAccessError(projectAccessErrorCodes.memberAlreadyAdded);

      const id = crypto.randomUUID();
      await transaction.insert(pacaProjectMembers).values({ id, projectId, userId });
      await transaction.insert(pacaProjectMemberRoles).values({ memberId: id, roleId, projectId });
      return id;
    });
    return await this.findMember(projectId, memberId);
  }

  async replaceMemberRole(
    projectId: string,
    memberId: string,
    roleId: string,
    assertAssignable: (role: ProjectRole) => void,
  ): Promise<ProjectMember> {
    await this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(${PROJECT_ACCESS_ADVISORY_LOCK})`);
      await this.requireActiveProject(transaction, projectId);
      const [member] = await transaction
        .select({ id: pacaProjectMembers.id })
        .from(pacaProjectMembers)
        .where(
          and(eq(pacaProjectMembers.id, memberId), eq(pacaProjectMembers.projectId, projectId)),
        )
        .limit(1);
      if (!member) throw new ProjectAccessError(projectAccessErrorCodes.memberNotFound);

      const role = await this.readRole(transaction, projectId, roleId);
      assertAssignable(role);
      await this.requireAdminRemains(transaction, projectId, memberId, roleId);

      await transaction
        .delete(pacaProjectMemberRoles)
        .where(
          and(
            eq(pacaProjectMemberRoles.memberId, memberId),
            eq(pacaProjectMemberRoles.projectId, projectId),
          ),
        );
      await transaction.insert(pacaProjectMemberRoles).values({ memberId, roleId, projectId });
    });
    return await this.findMember(projectId, memberId);
  }

  async removeMember(projectId: string, memberId: string): Promise<{ userId: string }> {
    return await this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(${PROJECT_ACCESS_ADVISORY_LOCK})`);
      await this.requireActiveProject(transaction, projectId);
      const [member] = await transaction
        .select({ id: pacaProjectMembers.id, userId: pacaProjectMembers.userId })
        .from(pacaProjectMembers)
        .where(
          and(eq(pacaProjectMembers.id, memberId), eq(pacaProjectMembers.projectId, projectId)),
        )
        .limit(1);
      if (!member) throw new ProjectAccessError(projectAccessErrorCodes.memberNotFound);

      await this.requireAdminRemains(transaction, projectId, memberId, null);
      await transaction
        .delete(pacaProjectMembers)
        .where(
          and(eq(pacaProjectMembers.id, memberId), eq(pacaProjectMembers.projectId, projectId)),
        );
      return { userId: member.userId };
    });
  }

  async listUsers(page: number, pageSize: number): Promise<DirectoryUserList> {
    const [[totalRow], rows] = await Promise.all([
      this.database.select({ value: count() }).from(user),
      this.database
        .select({
          id: user.id,
          name: user.name,
          email: user.email,
          image: user.image,
          createdAt: user.createdAt,
        })
        .from(user)
        .orderBy(asc(user.name), asc(user.email))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
    ]);
    return { items: rows, total: Number(totalRow?.value ?? 0), page, pageSize };
  }

  private async requireActiveProject(executor: PacaTransaction, projectId: string): Promise<void> {
    const [project] = await executor
      .select({ id: pacaProjects.id })
      .from(pacaProjects)
      .where(and(eq(pacaProjects.id, projectId), eq(pacaProjects.status, "active")))
      .limit(1);
    if (!project) throw new ProjectAccessError(projectAccessErrorCodes.memberNotFound);
  }

  private async readRole(
    executor: PacaTransaction,
    projectId: string,
    roleId: string,
  ): Promise<ProjectRole> {
    const rows = await executor
      .select({
        id: pacaProjectRoles.id,
        projectId: pacaProjectRoles.projectId,
        name: pacaProjectRoles.name,
        description: pacaProjectRoles.description,
        isBuiltIn: pacaProjectRoles.isBuiltIn,
        createdAt: pacaProjectRoles.createdAt,
        updatedAt: pacaProjectRoles.updatedAt,
        resource: pacaRolePermissions.resource,
        action: pacaRolePermissions.action,
      })
      .from(pacaProjectRoles)
      .leftJoin(pacaRolePermissions, eq(pacaProjectRoles.id, pacaRolePermissions.roleId))
      .where(and(eq(pacaProjectRoles.id, roleId), eq(pacaProjectRoles.projectId, projectId)));
    const [role] = hydrateRoles(rows);
    if (!role) throw new ProjectAccessError(projectAccessErrorCodes.roleNotFound);
    return role;
  }

  private async requireAdminRemains(
    executor: PacaTransaction,
    projectId: string,
    memberId: string,
    replacementRoleId: string | null,
  ): Promise<void> {
    const [adminRole] = await executor
      .select({ id: pacaProjectRoles.id })
      .from(pacaProjectRoles)
      .where(
        and(
          eq(pacaProjectRoles.projectId, projectId),
          eq(pacaProjectRoles.name, ADMIN_ROLE_NAME),
          eq(pacaProjectRoles.isBuiltIn, true),
        ),
      )
      .limit(1);
    if (!adminRole) throw new Error("PROJECT_ADMIN_ROLE_NOT_SEEDED");
    if (replacementRoleId === adminRole.id) return;

    const [targetIsAdmin] = await executor
      .select({ roleId: pacaProjectMemberRoles.roleId })
      .from(pacaProjectMemberRoles)
      .where(
        and(
          eq(pacaProjectMemberRoles.projectId, projectId),
          eq(pacaProjectMemberRoles.memberId, memberId),
          eq(pacaProjectMemberRoles.roleId, adminRole.id),
        ),
      )
      .limit(1);
    if (!targetIsAdmin) return;

    const [adminCount] = await executor
      .select({ value: countDistinct(pacaProjectMemberRoles.memberId) })
      .from(pacaProjectMemberRoles)
      .where(
        and(
          eq(pacaProjectMemberRoles.projectId, projectId),
          eq(pacaProjectMemberRoles.roleId, adminRole.id),
        ),
      );
    if (Number(adminCount?.value ?? 0) <= 1) {
      throw new ProjectAccessError(projectAccessErrorCodes.lastAdmin);
    }
  }

  private async findMember(projectId: string, memberId: string): Promise<ProjectMember> {
    const member = (await this.listMembers(projectId)).find((item) => item.id === memberId);
    if (!member) throw new ProjectAccessError(projectAccessErrorCodes.memberNotFound);
    return member;
  }
}
