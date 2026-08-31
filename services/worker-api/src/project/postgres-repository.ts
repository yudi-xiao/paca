import { and, asc, count, countDistinct, desc, eq, isNull, ne, or, sql } from "drizzle-orm";

import type { PacaDatabase } from "../database";
import {
  pacaProjectMemberRoles,
  pacaProjectMembers,
  pacaProjectRoles,
  pacaProjects,
  pacaRolePermissions,
  pacaTaskCounters,
  pacaTaskStatuses,
  pacaTasks,
  pacaTaskTypes,
  pacaTaskViews,
} from "../db/schema";
import type {
  PersistedProjectCreate,
  PersistedProjectUpdate,
  Project,
  ProjectList,
  ProjectRepository,
  ProjectStats,
} from "./service";
import { ProjectError, projectErrorCodes } from "./service";

const PROJECT_ADVISORY_LOCK = 1885432673;

function projectFromRow(row: typeof pacaProjects.$inferSelect): Project {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    description: row.description,
    taskIdPrefix: row.taskIdPrefix,
    isPublic: row.isPublic,
    settings: row.settings,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PostgresProjectRepository implements ProjectRepository {
  constructor(private readonly database: PacaDatabase) {}

  async list(organizationId: string, page: number, pageSize: number): Promise<ProjectList> {
    const where = and(
      eq(pacaProjects.organizationId, organizationId),
      eq(pacaProjects.status, "active"),
    );
    const [[totalRow], rows] = await Promise.all([
      this.database.select({ value: count() }).from(pacaProjects).where(where),
      this.database
        .select()
        .from(pacaProjects)
        .where(where)
        .orderBy(desc(pacaProjects.createdAt), asc(pacaProjects.name))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
    ]);
    return {
      items: rows.map(projectFromRow),
      total: Number(totalRow?.value ?? 0),
      page,
      pageSize,
    };
  }

  async stats(organizationId: string): Promise<ProjectStats> {
    const [[memberCount], [taskCount]] = await Promise.all([
      this.database
        .select({ value: countDistinct(pacaProjectMembers.userId) })
        .from(pacaProjectMembers)
        .innerJoin(pacaProjects, eq(pacaProjectMembers.projectId, pacaProjects.id))
        .where(
          and(eq(pacaProjects.organizationId, organizationId), eq(pacaProjects.status, "active")),
        ),
      this.database
        .select({ value: count() })
        .from(pacaTasks)
        .innerJoin(pacaProjects, eq(pacaTasks.projectId, pacaProjects.id))
        .leftJoin(pacaTaskStatuses, eq(pacaTasks.statusId, pacaTaskStatuses.id))
        .where(
          and(
            eq(pacaProjects.organizationId, organizationId),
            eq(pacaProjects.status, "active"),
            isNull(pacaTasks.deletedAt),
            or(isNull(pacaTasks.statusId), ne(pacaTaskStatuses.category, "done")),
          ),
        ),
    ]);
    return {
      openTaskCount: Number(taskCount?.value ?? 0),
      teamMemberCount: Number(memberCount?.value ?? 0),
      aiAgentCount: 0,
    };
  }

  async findById(projectId: string): Promise<Project> {
    const [row] = await this.database
      .select()
      .from(pacaProjects)
      .where(and(eq(pacaProjects.id, projectId), eq(pacaProjects.status, "active")))
      .limit(1);
    if (!row) throw new ProjectError(projectErrorCodes.notFound);
    return projectFromRow(row);
  }

  async create(input: PersistedProjectCreate): Promise<Project> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(${PROJECT_ADVISORY_LOCK})`);
      const [nameConflict] = await transaction
        .select({ id: pacaProjects.id })
        .from(pacaProjects)
        .where(
          and(
            eq(pacaProjects.organizationId, input.organizationId),
            sql`lower(${pacaProjects.name}) = lower(${input.name})`,
          ),
        )
        .limit(1);
      if (nameConflict) throw new ProjectError(projectErrorCodes.nameTaken);

      const [row] = await transaction
        .insert(pacaProjects)
        .values({
          id: input.id,
          organizationId: input.organizationId,
          name: input.name,
          slug: input.slug,
          description: input.description,
          taskIdPrefix: input.taskIdPrefix,
          isPublic: input.isPublic,
          settings: input.settings,
          status: "active",
          createdBy: input.createdBy,
        })
        .returning();
      if (!row) throw new Error("PROJECT_CREATE_FAILED");

      await transaction.insert(pacaProjectRoles).values(
        input.defaultRoles.map((role) => ({
          id: role.id,
          projectId: input.id,
          name: role.name,
          description: role.description,
          isBuiltIn: true,
        })),
      );
      await transaction.insert(pacaRolePermissions).values(
        input.defaultRoles.flatMap((role) =>
          role.grants.map((grant) => ({
            roleId: role.id,
            resource: grant.resource,
            action: grant.action,
          })),
        ),
      );

      const adminRole = input.defaultRoles.find((role) => role.name === "Admin");
      if (!adminRole) throw new Error("PROJECT_ADMIN_ROLE_NOT_DEFINED");
      const memberId = crypto.randomUUID();
      await transaction.insert(pacaProjectMembers).values({
        id: memberId,
        projectId: input.id,
        userId: input.createdBy,
      });
      await transaction.insert(pacaProjectMemberRoles).values({
        memberId,
        roleId: adminRole.id,
        projectId: input.id,
      });
      await transaction.insert(pacaTaskTypes).values(
        input.defaultTaskTypes.map((taskType) => ({
          ...taskType,
          projectId: input.id,
        })),
      );
      await transaction.insert(pacaTaskStatuses).values(
        input.defaultTaskStatuses.map((status) => ({
          ...status,
          projectId: input.id,
        })),
      );
      await transaction.insert(pacaTaskCounters).values({ projectId: input.id, lastValue: 0 });
      await transaction.insert(pacaTaskViews).values([
        {
          id: crypto.randomUUID(),
          projectId: input.id,
          sprintId: null,
          name: "Table",
          viewType: "table",
          viewContext: "backlog",
          config: {
            column_by: "sprint",
            filters: {
              task_types: { all: false, items: { normal: { all: true } } },
            },
          },
          position: 0,
        },
        {
          id: crypto.randomUUID(),
          projectId: input.id,
          sprintId: null,
          name: "Roadmap",
          viewType: "roadmap",
          viewContext: "timeline",
          config: {},
          position: 0,
        },
      ]);

      return projectFromRow(row);
    });
  }

  async update(projectId: string, input: PersistedProjectUpdate): Promise<Project> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(${PROJECT_ADVISORY_LOCK})`);
      const [current] = await transaction
        .select()
        .from(pacaProjects)
        .where(and(eq(pacaProjects.id, projectId), eq(pacaProjects.status, "active")))
        .limit(1);
      if (!current) throw new ProjectError(projectErrorCodes.notFound);

      if (input.name !== undefined) {
        const [nameConflict] = await transaction
          .select({ id: pacaProjects.id })
          .from(pacaProjects)
          .where(
            and(
              eq(pacaProjects.organizationId, current.organizationId),
              sql`lower(${pacaProjects.name}) = lower(${input.name})`,
              ne(pacaProjects.id, projectId),
            ),
          )
          .limit(1);
        if (nameConflict) throw new ProjectError(projectErrorCodes.nameTaken);
      }

      const [row] = await transaction
        .update(pacaProjects)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(pacaProjects.id, projectId), eq(pacaProjects.status, "active")))
        .returning();
      if (!row) throw new ProjectError(projectErrorCodes.notFound);
      return projectFromRow(row);
    });
  }

  async archive(projectId: string): Promise<void> {
    const [row] = await this.database
      .update(pacaProjects)
      .set({ status: "archived", updatedAt: new Date() })
      .where(and(eq(pacaProjects.id, projectId), eq(pacaProjects.status, "active")))
      .returning({ id: pacaProjects.id });
    if (!row) throw new ProjectError(projectErrorCodes.notFound);
  }
}
