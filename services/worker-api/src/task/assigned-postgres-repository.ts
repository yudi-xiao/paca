import {
  and,
  asc,
  countDistinct,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";

import type { PacaDatabase } from "../database";
import {
  pacaProjectMembers,
  pacaProjects,
  pacaTaskAssignees,
  pacaTaskStatuses,
  pacaTasks,
} from "../db/schema";
import type { AssignedTaskCursor, AssignedTaskRepository } from "./assigned-service";
import { taskFromRow } from "./postgres-repository";

export class PostgresAssignedTaskRepository implements AssignedTaskRepository {
  constructor(private readonly database: PacaDatabase) {}

  async listCandidateProjectIds(userId: string): Promise<string[]> {
    const rows = await this.database
      .selectDistinct({ projectId: pacaProjectMembers.projectId })
      .from(pacaProjectMembers)
      .innerJoin(pacaProjects, eq(pacaProjectMembers.projectId, pacaProjects.id))
      .innerJoin(pacaTaskAssignees, eq(pacaProjectMembers.id, pacaTaskAssignees.memberId))
      .innerJoin(pacaTasks, eq(pacaTaskAssignees.taskId, pacaTasks.id))
      .leftJoin(pacaTaskStatuses, eq(pacaTasks.statusId, pacaTaskStatuses.id))
      .where(
        and(
          eq(pacaProjectMembers.userId, userId),
          eq(pacaProjects.status, "active"),
          isNull(pacaTasks.deletedAt),
          or(isNull(pacaTaskStatuses.id), ne(pacaTaskStatuses.category, "done")),
        ),
      );
    return rows.map(({ projectId }) => projectId);
  }

  async list(
    userId: string,
    readableProjectIds: string[],
    input: { pageSize: number; cursor: AssignedTaskCursor | null },
  ) {
    const cursorCondition = input.cursor
      ? or(
          lt(pacaTasks.importance, input.cursor.importance),
          and(
            eq(pacaTasks.importance, input.cursor.importance),
            or(
              sql`${pacaTasks.createdAt} > ${input.cursor.createdAt}::timestamptz`,
              and(
                sql`${pacaTasks.createdAt} = ${input.cursor.createdAt}::timestamptz`,
                sql`${pacaTasks.id} > ${input.cursor.id}::uuid`,
              ),
            ),
          ),
        )
      : undefined;
    const where = and(
      eq(pacaProjectMembers.userId, userId),
      inArray(pacaTasks.projectId, readableProjectIds),
      isNull(pacaTasks.deletedAt),
      or(isNull(pacaTaskStatuses.id), ne(pacaTaskStatuses.category, "done")),
      cursorCondition,
    );
    const baseWhere = and(
      eq(pacaProjectMembers.userId, userId),
      inArray(pacaTasks.projectId, readableProjectIds),
      isNull(pacaTasks.deletedAt),
      or(isNull(pacaTaskStatuses.id), ne(pacaTaskStatuses.category, "done")),
    );
    const rows = await this.database
      .select({
        ...getTableColumns(pacaTasks),
        cursorCreatedAt: sql<string>`to_char(${pacaTasks.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(pacaTasks)
      .leftJoin(pacaTaskStatuses, eq(pacaTasks.statusId, pacaTaskStatuses.id))
      .innerJoin(pacaTaskAssignees, eq(pacaTasks.id, pacaTaskAssignees.taskId))
      .innerJoin(pacaProjectMembers, eq(pacaTaskAssignees.memberId, pacaProjectMembers.id))
      .where(where)
      .orderBy(desc(pacaTasks.importance), asc(pacaTasks.createdAt), asc(pacaTasks.id))
      .limit(input.pageSize + 1);
    const [total] = await this.database
      .select({ value: countDistinct(pacaTasks.id) })
      .from(pacaTasks)
      .leftJoin(pacaTaskStatuses, eq(pacaTasks.statusId, pacaTaskStatuses.id))
      .innerJoin(pacaTaskAssignees, eq(pacaTasks.id, pacaTaskAssignees.taskId))
      .innerJoin(pacaProjectMembers, eq(pacaTaskAssignees.memberId, pacaProjectMembers.id))
      .where(baseWhere);
    const hasMore = rows.length > input.pageSize;
    const pageRows = hasMore ? rows.slice(0, input.pageSize) : rows;
    const taskIds = pageRows.map(({ id }) => id);
    const assigneeRows =
      taskIds.length === 0
        ? []
        : await this.database
            .select({ taskId: pacaTaskAssignees.taskId, memberId: pacaTaskAssignees.memberId })
            .from(pacaTaskAssignees)
            .where(inArray(pacaTaskAssignees.taskId, taskIds));
    const assigneesByTask = new Map<string, string[]>();
    for (const { taskId, memberId } of assigneeRows) {
      const memberIds = assigneesByTask.get(taskId) ?? [];
      memberIds.push(memberId);
      assigneesByTask.set(taskId, memberIds);
    }
    return {
      items: pageRows.map(({ cursorCreatedAt, ...row }) => ({
        task: taskFromRow(row, assigneesByTask.get(row.id) ?? []),
        cursor: { createdAt: cursorCreatedAt, id: row.id, importance: row.importance },
      })),
      totalCount: total?.value ?? 0,
      hasMore,
    };
  }
}
