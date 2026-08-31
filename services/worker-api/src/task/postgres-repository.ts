import { Buffer } from "node:buffer";

import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  or,
  type SQL,
  type SQLWrapper,
  sql,
} from "drizzle-orm";

import type { PacaDatabase } from "../database";
import {
  pacaCustomFieldDefinitions,
  pacaProjectMembers,
  pacaProjects,
  pacaSprints,
  pacaTaskActivities,
  pacaTaskAssignees,
  pacaTaskCounters,
  pacaTaskStatuses,
  pacaTasks,
  pacaTaskTypes,
  pacaTaskViews,
  pacaViewTaskPositions,
} from "../db/schema";
import {
  type NormalizedTaskListInput,
  type PersistedTaskCreate,
  type PersistedTaskUpdate,
  type Task,
  type TaskActor,
  TaskError,
  type TaskList,
  type TaskRepository,
  type TaskStatus,
  type TaskStatusCategory,
  type TaskType,
  taskErrorCodes,
} from "./service";

type TaskRow = typeof pacaTasks.$inferSelect;
type TaskWriteDatabase = Pick<PacaDatabase, "insert" | "select">;

type TaskFieldChange = {
  field: string;
  old: unknown;
  new: unknown;
};

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameStringSet(left: string[], right: string[]): boolean {
  return sameJson([...left].sort(), [...right].sort());
}

function typeFromRow(row: typeof pacaTaskTypes.$inferSelect): TaskType {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    icon: row.icon,
    color: row.color,
    description: row.description,
    isDefault: row.isDefault,
    isSystem: row.isSystem,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function statusFromRow(row: typeof pacaTaskStatuses.$inferSelect): TaskStatus {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    color: row.color,
    position: row.position,
    category: row.category as TaskStatusCategory,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function taskFromRow(row: TaskRow, assigneeIds: string[]): Task {
  return {
    id: row.id,
    projectId: row.projectId,
    taskNumber: row.taskNumber,
    taskTypeId: row.taskTypeId,
    statusId: row.statusId,
    sprintId: row.sprintId,
    parentTaskId: row.parentTaskId,
    title: row.title,
    description: row.description ?? null,
    importance: row.importance,
    storyPoints: row.storyPoints,
    assigneeIds,
    reporterId: row.reporterId,
    customFields: row.customFields,
    startDate: row.startDate,
    dueDate: row.dueDate,
    tags: row.tags,
    viewPosition: null,
    viewGroupKey: null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

type TaskCursor = {
  v: 1;
  sort: string;
  createdAt: string;
  id: string;
  value: string | number | null;
};

type ResolvedTaskSort = {
  key: string;
  expression: SQLWrapper;
  direction: "asc" | "desc";
  nullsLast: boolean;
  valueType: "created" | "number" | "string";
};

function encodeTaskCursor(cursor: TaskCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeTaskCursor(value: string): TaskCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<TaskCursor>;
    if (
      parsed.v !== 1 ||
      typeof parsed.sort !== "string" ||
      typeof parsed.createdAt !== "string" ||
      Number.isNaN(Date.parse(parsed.createdAt)) ||
      typeof parsed.id !== "string" ||
      !Object.hasOwn(parsed, "value") ||
      (parsed.value !== null &&
        typeof parsed.value !== "string" &&
        typeof parsed.value !== "number")
    ) {
      throw new Error("invalid cursor payload");
    }
    return parsed as TaskCursor;
  } catch {
    throw new TaskError(taskErrorCodes.cursorInvalid);
  }
}

function safeNumericCustomField(fieldKey: string): SQL<number | null> {
  // PostgreSQL-specific escape hatch: values are JSONB and can outlive a field
  // definition change, so the cast must be guarded instead of trusting old rows.
  return sql<
    number | null
  >`case when (${pacaTasks.customFields} ->> ${fieldKey}) ~ '^-?[0-9]+(\\.[0-9]+)?$' then (${pacaTasks.customFields} ->> ${fieldKey})::numeric end`;
}

function safeDateCustomField(fieldKey: string): SQL<string | null> {
  return sql<
    string | null
  >`case when (${pacaTasks.customFields} ->> ${fieldKey}) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then (${pacaTasks.customFields} ->> ${fieldKey})::date end`;
}

function selectCustomFieldOrder(fieldKey: string, options: string[]): SQL<number> {
  if (options.length === 0) return sql<number>`9999`;
  const cases = options.map((option, index) => sql`when ${option} then ${index}`);
  return sql<number>`case ${pacaTasks.customFields} ->> ${fieldKey} ${sql.join(cases, sql.raw(" "))} else 9999 end`;
}

function tieAfter(createdAt: string, id: string): SQL {
  return sql`(${pacaTasks.createdAt}, ${pacaTasks.id}) > (${new Date(createdAt)}, ${id})`;
}

function cursorCondition(cursor: TaskCursor, sort: ResolvedTaskSort): SQL {
  if (cursor.sort !== sort.key) throw new TaskError(taskErrorCodes.cursorInvalid);
  if (sort.key === "created") return tieAfter(cursor.createdAt, cursor.id);

  const tie = tieAfter(cursor.createdAt, cursor.id);
  if (cursor.value === null) {
    if (!sort.nullsLast) throw new TaskError(taskErrorCodes.cursorInvalid);
    return sql`(${sort.expression} is null and ${tie})`;
  }
  const beyond =
    sort.direction === "desc"
      ? sql`${sort.expression} < ${cursor.value}`
      : sql`${sort.expression} > ${cursor.value}`;
  const equalAndAfter = sql`(${sort.expression} = ${cursor.value} and ${tie})`;
  return sort.nullsLast
    ? sql`(${beyond} or ${equalAndAfter} or ${sort.expression} is null)`
    : sql`(${beyond} or ${equalAndAfter})`;
}

export class PostgresTaskRepository implements TaskRepository {
  constructor(private readonly database: PacaDatabase) {}

  async listTypes(projectId: string): Promise<TaskType[]> {
    const rows = await this.database
      .select()
      .from(pacaTaskTypes)
      .where(eq(pacaTaskTypes.projectId, projectId))
      .orderBy(desc(pacaTaskTypes.isDefault), asc(pacaTaskTypes.name));
    return rows.map(typeFromRow);
  }

  async listStatuses(projectId: string): Promise<TaskStatus[]> {
    const rows = await this.database
      .select()
      .from(pacaTaskStatuses)
      .where(eq(pacaTaskStatuses.projectId, projectId))
      .orderBy(asc(pacaTaskStatuses.position), asc(pacaTaskStatuses.name));
    return rows.map(statusFromRow);
  }

  async list(projectId: string, input: NormalizedTaskListInput): Promise<TaskList> {
    const fieldDefinitions = await this.database
      .select({
        fieldKey: pacaCustomFieldDefinitions.fieldKey,
        fieldType: pacaCustomFieldDefinitions.fieldType,
        options: pacaCustomFieldDefinitions.options,
      })
      .from(pacaCustomFieldDefinitions)
      .where(eq(pacaCustomFieldDefinitions.projectId, projectId));
    const fieldByKey = new Map(fieldDefinitions.map((field) => [field.fieldKey, field]));

    if (input.viewId !== null) {
      const [view] = await this.database
        .select({ id: pacaTaskViews.id })
        .from(pacaTaskViews)
        .where(and(eq(pacaTaskViews.id, input.viewId), eq(pacaTaskViews.projectId, projectId)))
        .limit(1);
      if (!view) throw new TaskError(taskErrorCodes.filterInvalid);
    }

    const requestedSort = input.sortBy === "manual" ? null : input.sortBy;
    let sort: ResolvedTaskSort;
    if (requestedSort === null && input.viewId !== null) {
      sort = {
        key: "view_position",
        expression: pacaViewTaskPositions.position,
        direction: "asc",
        nullsLast: true,
        valueType: "number",
      };
    } else if (requestedSort === "importance") {
      sort = {
        key: "importance",
        expression: pacaTasks.importance,
        direction: "desc",
        nullsLast: false,
        valueType: "number",
      };
    } else if (requestedSort === "title") {
      sort = {
        key: "title",
        expression: pacaTasks.title,
        direction: "asc",
        nullsLast: false,
        valueType: "string",
      };
    } else if (requestedSort === "story_points") {
      sort = {
        key: "story_points",
        expression: pacaTasks.storyPoints,
        direction: "desc",
        nullsLast: true,
        valueType: "number",
      };
    } else if (requestedSort === "start_date" || requestedSort === "due_date") {
      sort = {
        key: requestedSort,
        expression: requestedSort === "start_date" ? pacaTasks.startDate : pacaTasks.dueDate,
        direction: "asc",
        nullsLast: true,
        valueType: "string",
      };
    } else {
      const field = requestedSort ? fieldByKey.get(requestedSort) : undefined;
      if (field?.fieldType === "number") {
        sort = {
          key: requestedSort as string,
          expression: safeNumericCustomField(requestedSort as string),
          direction: "asc",
          nullsLast: true,
          valueType: "number",
        };
      } else if (field?.fieldType === "date") {
        sort = {
          key: requestedSort as string,
          expression: safeDateCustomField(requestedSort as string),
          direction: "asc",
          nullsLast: true,
          valueType: "string",
        };
      } else if (field?.fieldType === "select") {
        sort = {
          key: requestedSort as string,
          expression: selectCustomFieldOrder(requestedSort as string, field.options),
          direction: "asc",
          nullsLast: false,
          valueType: "number",
        };
      } else {
        sort = {
          key: "created",
          expression: pacaTasks.createdAt,
          direction: "asc",
          nullsLast: false,
          valueType: "created",
        };
      }
    }

    const conditions: SQL[] = [eq(pacaTasks.projectId, projectId), isNull(pacaTasks.deletedAt)];
    if (input.sprintIds.length > 0) conditions.push(inArray(pacaTasks.sprintId, input.sprintIds));
    else if (input.sprintId === null) conditions.push(isNull(pacaTasks.sprintId));
    else if (input.sprintId !== undefined) conditions.push(eq(pacaTasks.sprintId, input.sprintId));
    if (input.statusIds.length > 0) conditions.push(inArray(pacaTasks.statusId, input.statusIds));
    if (input.taskTypeNull) conditions.push(isNull(pacaTasks.taskTypeId));
    else if (input.taskTypeIds.length > 0) {
      conditions.push(inArray(pacaTasks.taskTypeId, input.taskTypeIds));
    }
    if (input.parentTaskId !== null)
      conditions.push(eq(pacaTasks.parentTaskId, input.parentTaskId));

    const assigneeIds = input.assigneeIds;
    const noAssignee = sql`not exists (select 1 from "paca_task_assignee" ta where ta."task_id" = ${pacaTasks.id})`;
    const hasAssignee =
      assigneeIds.length === 0
        ? null
        : sql`exists (select 1 from "paca_task_assignee" ta where ta."task_id" = ${pacaTasks.id} and ta."member_id" in (${sql.join(
            assigneeIds.map((id) => sql`${id}`),
            sql.raw(", "),
          )}))`;
    if (input.assigneeNull && hasAssignee) conditions.push(sql`(${noAssignee} or ${hasAssignee})`);
    else if (input.assigneeNull) conditions.push(noAssignee);
    else if (hasAssignee) conditions.push(hasAssignee);

    if (input.search !== null) {
      const pattern = `%${input.search
        .replaceAll("\\", "\\\\")
        .replaceAll("%", "\\%")
        .replaceAll("_", "\\_")}%`;
      const searchCondition = or(
        ilike(pacaTasks.title, pattern),
        sql`('#' || ${pacaTasks.taskNumber}::text) ilike ${pattern}`,
      );
      if (searchCondition) conditions.push(searchCondition);
    }
    if (input.startDateAfter !== null)
      conditions.push(gte(pacaTasks.startDate, input.startDateAfter));
    if (input.startDateBefore !== null)
      conditions.push(lte(pacaTasks.startDate, input.startDateBefore));
    if (input.dueDateAfter !== null) conditions.push(gte(pacaTasks.dueDate, input.dueDateAfter));
    if (input.dueDateBefore !== null) conditions.push(lte(pacaTasks.dueDate, input.dueDateBefore));
    if (input.storyPointsMin !== null)
      conditions.push(gte(pacaTasks.storyPoints, input.storyPointsMin));
    if (input.storyPointsMax !== null)
      conditions.push(lte(pacaTasks.storyPoints, input.storyPointsMax));
    if (input.importanceRanges.length > 0) {
      const ranges = input.importanceRanges.map(({ min, max }) =>
        and(gte(pacaTasks.importance, min), lte(pacaTasks.importance, max)),
      );
      const rangeCondition = or(...ranges);
      if (rangeCondition) conditions.push(rangeCondition);
    }
    if (input.tags.length > 0) {
      conditions.push(sql`${pacaTasks.tags} ?| ${input.tags}::text[]`);
    }

    for (const [fieldKey, filter] of Object.entries(input.customFieldFilters).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const definition = fieldByKey.get(fieldKey);
      if (!definition) continue;
      const textValue = sql`${pacaTasks.customFields} ->> ${fieldKey}`;
      if (
        (definition.fieldType === "select" || definition.fieldType === "boolean") &&
        filter.values?.length
      ) {
        conditions.push(inArray(textValue, filter.values.slice(0, 100)));
      } else if (definition.fieldType === "multi_select" && filter.values?.length) {
        conditions.push(
          sql`(${pacaTasks.customFields} -> ${fieldKey}) ?| ${filter.values.slice(0, 100)}::text[]`,
        );
      } else if (definition.fieldType === "number") {
        const value = safeNumericCustomField(fieldKey);
        if (filter.min !== undefined) conditions.push(gte(value, filter.min));
        if (filter.max !== undefined) conditions.push(lte(value, filter.max));
      } else if (definition.fieldType === "date") {
        const value = safeDateCustomField(fieldKey);
        if (filter.after !== undefined) conditions.push(gte(value, filter.after));
        if (filter.before !== undefined) conditions.push(lte(value, filter.before));
      } else if (
        (definition.fieldType === "text" || definition.fieldType === "url") &&
        filter.contains?.trim()
      ) {
        const pattern = `%${filter.contains
          .trim()
          .replaceAll("\\", "\\\\")
          .replaceAll("%", "\\%")
          .replaceAll("_", "\\_")}%`;
        conditions.push(ilike(textValue, pattern));
      }
    }

    const aggregateWhere = and(...conditions);
    const pageConditions = [...conditions];
    if (input.cursor !== null)
      pageConditions.push(cursorCondition(decodeTaskCursor(input.cursor), sort));
    const pageWhere = and(...pageConditions);
    const joinCondition =
      input.viewId === null
        ? sql`false`
        : and(
            eq(pacaViewTaskPositions.viewId, input.viewId),
            eq(pacaViewTaskPositions.projectId, projectId),
            eq(pacaViewTaskPositions.taskId, pacaTasks.id),
          );
    const primaryOrder = sql`${sort.expression} ${sql.raw(sort.direction)}${
      sort.nullsLast ? sql.raw(" nulls last") : sql.raw("")
    }`;

    const sumDefinition = input.sumField ? fieldByKey.get(input.sumField) : undefined;
    let sumExpression: SQLWrapper | null = null;
    if (input.sumField === "story_points") sumExpression = pacaTasks.storyPoints;
    else if (input.sumField !== null) {
      if (sumDefinition?.fieldType !== "number") {
        throw new TaskError(taskErrorCodes.sumFieldInvalid);
      }
      sumExpression = safeNumericCustomField(input.sumField);
    }

    const pageQuery = this.database
      .select({
        ...getTableColumns(pacaTasks),
        viewPosition: pacaViewTaskPositions.position,
        viewGroupKey: pacaViewTaskPositions.groupKey,
        sortValue: sql<string | number | null>`${sort.expression}`,
      })
      .from(pacaTasks)
      .leftJoin(pacaViewTaskPositions, joinCondition)
      .where(pageWhere)
      .orderBy(
        ...(sort.key === "created" ? [] : [primaryOrder]),
        asc(pacaTasks.createdAt),
        asc(pacaTasks.id),
      )
      .limit(input.pageSize + 1);
    const countQuery = this.database
      .select({ value: count() })
      .from(pacaTasks)
      .where(aggregateWhere);
    const sumQuery = sumExpression
      ? this.database
          .select({ value: sql<string>`coalesce(sum(${sumExpression}), 0)::text` })
          .from(pacaTasks)
          .where(aggregateWhere)
      : Promise.resolve([{ value: null }]);
    const [[totalRow], pageRows, [sumRow]] = await Promise.all([countQuery, pageQuery, sumQuery]);
    const hasMore = pageRows.length > input.pageSize;
    const rows = hasMore ? pageRows.slice(0, input.pageSize) : pageRows;
    const taskRows = rows.map(
      ({ viewPosition: _position, viewGroupKey: _group, sortValue: _sort, ...row }) => row,
    );
    const items = await this.hydrate(taskRows);
    for (const [index, item] of items.entries()) {
      item.viewPosition = rows[index]?.viewPosition ?? null;
      item.viewGroupKey = rows[index]?.viewGroupKey ?? null;
    }

    const last = rows.at(-1);
    let nextCursor: string | null = null;
    if (hasMore && last) {
      let value: TaskCursor["value"] = null;
      if (sort.valueType === "number" && last.sortValue !== null) value = Number(last.sortValue);
      else if (sort.valueType === "string" && last.sortValue !== null)
        value = String(last.sortValue);
      nextCursor = encodeTaskCursor({
        v: 1,
        sort: sort.key,
        createdAt: last.createdAt.toISOString(),
        id: last.id,
        value,
      });
    }
    return {
      items,
      pageSize: input.pageSize,
      nextCursor,
      totalCount: Number(totalRow?.value ?? 0),
      fieldSum: sumRow?.value === null ? null : Number(sumRow?.value ?? 0),
    };
  }

  async findById(projectId: string, taskId: string): Promise<Task> {
    const [row] = await this.database
      .select()
      .from(pacaTasks)
      .where(
        and(
          eq(pacaTasks.id, taskId),
          eq(pacaTasks.projectId, projectId),
          isNull(pacaTasks.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new TaskError(taskErrorCodes.notFound);
    return (await this.hydrate([row]))[0] as Task;
  }

  async create(input: PersistedTaskCreate): Promise<Task> {
    const row = await this.database.transaction(async (transaction) => {
      const [project] = await transaction
        .select({ id: pacaProjects.id })
        .from(pacaProjects)
        .where(and(eq(pacaProjects.id, input.projectId), eq(pacaProjects.status, "active")))
        .limit(1);
      if (!project) throw new TaskError(taskErrorCodes.notFound);

      const taskTypeId = await this.resolveTaskType(transaction, input.projectId, input.taskTypeId);
      const statusId = await this.resolveTaskStatus(transaction, input.projectId, input.statusId);
      await this.validateSprint(transaction, input.projectId, input.sprintId);
      await this.validateParent(transaction, input.projectId, input.parentTaskId, input.id);
      await this.validateAssignees(transaction, input.projectId, input.assigneeIds);
      await this.validateCustomFields(transaction, input.projectId, input.customFields);

      const actor = await this.activityActorValues(transaction, input.projectId, input.actor);

      const [counter] = await transaction
        .insert(pacaTaskCounters)
        .values({ projectId: input.projectId, lastValue: 1 })
        .onConflictDoUpdate({
          target: pacaTaskCounters.projectId,
          set: { lastValue: sql`${pacaTaskCounters.lastValue} + 1` },
        })
        .returning({ value: pacaTaskCounters.lastValue });
      if (!counter) throw new Error("TASK_COUNTER_INCREMENT_FAILED");

      const [created] = await transaction
        .insert(pacaTasks)
        .values({
          id: input.id,
          projectId: input.projectId,
          taskNumber: counter.value,
          taskTypeId,
          statusId,
          sprintId: input.sprintId ?? null,
          parentTaskId: input.parentTaskId ?? null,
          title: input.title,
          description: input.description,
          importance: input.importance,
          storyPoints: input.storyPoints,
          reporterId: actor.actorMemberId,
          customFields: input.customFields,
          startDate: input.startDate,
          dueDate: input.dueDate,
          tags: input.tags,
        })
        .returning();
      if (!created) throw new Error("TASK_CREATE_FAILED");
      if (input.assigneeIds.length > 0) {
        await transaction.insert(pacaTaskAssignees).values(
          input.assigneeIds.map((memberId) => ({
            taskId: input.id,
            memberId,
            projectId: input.projectId,
          })),
        );
      }
      await transaction.insert(pacaTaskActivities).values({
        id: crypto.randomUUID(),
        taskId: input.id,
        projectId: input.projectId,
        ...actor,
        activityType: "task.created",
        content: { title: input.title },
      });
      return created;
    });
    return (await this.hydrate([row]))[0] as Task;
  }

  async update(
    projectId: string,
    taskId: string,
    actor: TaskActor,
    input: PersistedTaskUpdate,
  ): Promise<Task> {
    const row = await this.database.transaction(async (transaction) => {
      const [current] = await transaction
        .select()
        .from(pacaTasks)
        .where(
          and(
            eq(pacaTasks.id, taskId),
            eq(pacaTasks.projectId, projectId),
            isNull(pacaTasks.deletedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (!current) throw new TaskError(taskErrorCodes.notFound);

      const currentAssigneeIds =
        input.assigneeIds === undefined
          ? []
          : (
              await transaction
                .select({ memberId: pacaTaskAssignees.memberId })
                .from(pacaTaskAssignees)
                .where(eq(pacaTaskAssignees.taskId, taskId))
            ).map((row) => row.memberId);

      if (input.taskTypeId !== undefined) {
        await this.resolveTaskType(transaction, projectId, input.taskTypeId);
      }
      if (input.statusId !== undefined) {
        await this.resolveTaskStatus(transaction, projectId, input.statusId);
      }
      if (input.sprintId !== undefined) {
        await this.validateSprint(transaction, projectId, input.sprintId);
      }
      if (input.parentTaskId !== undefined) {
        await this.validateParent(transaction, projectId, input.parentTaskId, taskId);
      }
      if (input.assigneeIds !== undefined) {
        await this.validateAssignees(transaction, projectId, input.assigneeIds);
      }
      if (input.customFields !== undefined) {
        await this.validateCustomFields(transaction, projectId, input.customFields);
      }

      const { assigneeIds, ...taskChanges } = input;
      const [updated] = await transaction
        .update(pacaTasks)
        .set({ ...taskChanges, updatedAt: new Date() })
        .where(and(eq(pacaTasks.id, taskId), eq(pacaTasks.projectId, projectId)))
        .returning();
      if (!updated) throw new TaskError(taskErrorCodes.notFound);

      if (assigneeIds !== undefined) {
        await transaction.delete(pacaTaskAssignees).where(eq(pacaTaskAssignees.taskId, taskId));
        if (assigneeIds.length > 0) {
          await transaction
            .insert(pacaTaskAssignees)
            .values(assigneeIds.map((memberId) => ({ taskId, memberId, projectId })));
        }
      }
      const changes = await this.buildFieldChanges(transaction, current, currentAssigneeIds, input);
      if (changes.length > 0) {
        await this.recordActivity(transaction, {
          projectId,
          taskId,
          actor,
          activityType: "task.updated",
          content: { changes },
        });
      }
      return updated;
    });
    return (await this.hydrate([row]))[0] as Task;
  }

  async archive(projectId: string, taskId: string, actor: TaskActor): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .update(pacaTasks)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(pacaTasks.id, taskId),
            eq(pacaTasks.projectId, projectId),
            isNull(pacaTasks.deletedAt),
          ),
        )
        .returning({ id: pacaTasks.id });
      if (!row) throw new TaskError(taskErrorCodes.notFound);
      await this.recordActivity(transaction, {
        projectId,
        taskId,
        actor,
        activityType: "task.deleted",
        content: {},
      });
    });
  }

  private async buildFieldChanges(
    database: Pick<PacaDatabase, "select">,
    current: TaskRow,
    currentAssigneeIds: string[],
    input: PersistedTaskUpdate,
  ): Promise<TaskFieldChange[]> {
    const changes: TaskFieldChange[] = [];
    if (input.title !== undefined && input.title !== current.title) {
      changes.push({ field: "title", old: current.title, new: input.title });
    }
    if (input.statusId !== undefined && input.statusId !== current.statusId) {
      changes.push({
        field: "status",
        old: await this.statusName(database, current.statusId),
        new: await this.statusName(database, input.statusId),
      });
    }
    if (input.sprintId !== undefined && input.sprintId !== current.sprintId) {
      changes.push({ field: "sprint", old: current.sprintId, new: input.sprintId });
    }
    if (input.taskTypeId !== undefined && input.taskTypeId !== current.taskTypeId) {
      changes.push({
        field: "task_type",
        old: await this.taskTypeName(database, current.taskTypeId),
        new: await this.taskTypeName(database, input.taskTypeId),
      });
    }
    if (input.parentTaskId !== undefined && input.parentTaskId !== current.parentTaskId) {
      changes.push({ field: "parent_task", old: current.parentTaskId, new: input.parentTaskId });
    }
    if (input.description !== undefined && !sameJson(input.description, current.description)) {
      changes.push({ field: "description", old: current.description, new: input.description });
    }
    if (input.importance !== undefined && input.importance !== current.importance) {
      changes.push({ field: "importance", old: current.importance, new: input.importance });
    }
    if (input.storyPoints !== undefined && input.storyPoints !== current.storyPoints) {
      changes.push({ field: "story_points", old: current.storyPoints, new: input.storyPoints });
    }
    if (input.assigneeIds !== undefined && !sameStringSet(input.assigneeIds, currentAssigneeIds)) {
      changes.push({ field: "assignee", old: currentAssigneeIds, new: input.assigneeIds });
    }
    if (input.customFields !== undefined && !sameJson(input.customFields, current.customFields)) {
      changes.push({ field: "custom_fields", old: current.customFields, new: input.customFields });
    }
    if (input.startDate !== undefined && input.startDate !== current.startDate) {
      changes.push({ field: "start_date", old: current.startDate, new: input.startDate });
    }
    if (input.dueDate !== undefined && input.dueDate !== current.dueDate) {
      changes.push({ field: "due_date", old: current.dueDate, new: input.dueDate });
    }
    if (input.tags !== undefined && !sameJson(input.tags, current.tags)) {
      changes.push({ field: "tags", old: current.tags, new: input.tags });
    }
    return changes;
  }

  private async statusName(
    database: Pick<PacaDatabase, "select">,
    statusId: string | null,
  ): Promise<string | null> {
    if (statusId === null) return null;
    const [status] = await database
      .select({ name: pacaTaskStatuses.name })
      .from(pacaTaskStatuses)
      .where(eq(pacaTaskStatuses.id, statusId))
      .limit(1);
    return status?.name ?? statusId;
  }

  private async taskTypeName(
    database: Pick<PacaDatabase, "select">,
    taskTypeId: string | null,
  ): Promise<string | null> {
    if (taskTypeId === null) return null;
    const [taskType] = await database
      .select({ name: pacaTaskTypes.name })
      .from(pacaTaskTypes)
      .where(eq(pacaTaskTypes.id, taskTypeId))
      .limit(1);
    return taskType?.name ?? taskTypeId;
  }

  private async recordActivity(
    database: TaskWriteDatabase,
    input: {
      projectId: string;
      taskId: string;
      actor: TaskActor;
      activityType: "task.updated" | "task.deleted";
      content: Record<string, unknown>;
    },
  ): Promise<void> {
    const actor = await this.activityActorValues(database, input.projectId, input.actor);
    await database.insert(pacaTaskActivities).values({
      id: crypto.randomUUID(),
      taskId: input.taskId,
      projectId: input.projectId,
      ...actor,
      activityType: input.activityType,
      content: input.content,
    });
  }

  private async activityActorValues(
    database: Pick<PacaDatabase, "select">,
    projectId: string,
    actor: TaskActor,
  ): Promise<{
    actorType: TaskActor["type"];
    actorId: string;
    actorUserId: string | null;
    actorAgentId: string | null;
    actorMemberId: string | null;
  }> {
    if (actor.type === "agent") {
      return {
        actorType: "agent",
        actorId: actor.id,
        actorUserId: null,
        actorAgentId: actor.id,
        actorMemberId: null,
      };
    }

    const [member] = await database
      .select({ id: pacaProjectMembers.id })
      .from(pacaProjectMembers)
      .where(
        and(eq(pacaProjectMembers.projectId, projectId), eq(pacaProjectMembers.userId, actor.id)),
      )
      .limit(1);
    return {
      actorType: "user",
      actorId: actor.id,
      actorUserId: actor.id,
      actorAgentId: null,
      actorMemberId: member?.id ?? null,
    };
  }

  private async hydrate(rows: TaskRow[]): Promise<Task[]> {
    if (rows.length === 0) return [];
    const assignments = await this.database
      .select({ taskId: pacaTaskAssignees.taskId, memberId: pacaTaskAssignees.memberId })
      .from(pacaTaskAssignees)
      .where(
        inArray(
          pacaTaskAssignees.taskId,
          rows.map((row) => row.id),
        ),
      );
    const byTask = new Map<string, string[]>();
    for (const assignment of assignments) {
      const ids = byTask.get(assignment.taskId) ?? [];
      ids.push(assignment.memberId);
      byTask.set(assignment.taskId, ids);
    }
    return rows.map((row) => taskFromRow(row, byTask.get(row.id) ?? []));
  }

  private async resolveTaskType(
    database: Pick<PacaDatabase, "select">,
    projectId: string,
    taskTypeId: string | null | undefined,
  ): Promise<string | null> {
    if (taskTypeId === null) return null;
    const where = taskTypeId
      ? and(eq(pacaTaskTypes.id, taskTypeId), eq(pacaTaskTypes.projectId, projectId))
      : and(eq(pacaTaskTypes.projectId, projectId), eq(pacaTaskTypes.isDefault, true));
    const [row] = await database
      .select({ id: pacaTaskTypes.id })
      .from(pacaTaskTypes)
      .where(where)
      .limit(1);
    if (!row && taskTypeId) throw new TaskError(taskErrorCodes.typeInvalid);
    return row?.id ?? null;
  }

  private async resolveTaskStatus(
    database: Pick<PacaDatabase, "select">,
    projectId: string,
    statusId: string | null | undefined,
  ): Promise<string | null> {
    if (statusId === null) return null;
    const where = statusId
      ? and(eq(pacaTaskStatuses.id, statusId), eq(pacaTaskStatuses.projectId, projectId))
      : and(eq(pacaTaskStatuses.projectId, projectId), eq(pacaTaskStatuses.isDefault, true));
    const [row] = await database
      .select({ id: pacaTaskStatuses.id })
      .from(pacaTaskStatuses)
      .where(where)
      .limit(1);
    if (!row && statusId) throw new TaskError(taskErrorCodes.statusInvalid);
    return row?.id ?? null;
  }

  private async validateSprint(
    database: Pick<PacaDatabase, "select">,
    projectId: string,
    sprintId: string | null | undefined,
  ): Promise<void> {
    if (sprintId === undefined || sprintId === null) return;
    const [sprint] = await database
      .select({ id: pacaSprints.id })
      .from(pacaSprints)
      .where(and(eq(pacaSprints.id, sprintId), eq(pacaSprints.projectId, projectId)))
      .limit(1);
    if (!sprint) throw new TaskError(taskErrorCodes.sprintInvalid);
  }

  private async validateParent(
    database: Pick<PacaDatabase, "select">,
    projectId: string,
    parentTaskId: string | null | undefined,
    taskId: string,
  ): Promise<void> {
    if (parentTaskId === undefined || parentTaskId === null) return;
    let currentParentId: string | null = parentTaskId;
    const visited = new Set<string>();
    for (let depth = 0; depth < 50 && currentParentId !== null; depth++) {
      if (currentParentId === taskId || visited.has(currentParentId)) {
        throw new TaskError(taskErrorCodes.parentInvalid);
      }
      visited.add(currentParentId);
      const [parent] = await database
        .select({ id: pacaTasks.id, parentTaskId: pacaTasks.parentTaskId })
        .from(pacaTasks)
        .where(
          and(
            eq(pacaTasks.id, currentParentId),
            eq(pacaTasks.projectId, projectId),
            isNull(pacaTasks.deletedAt),
          ),
        )
        .limit(1);
      if (!parent) throw new TaskError(taskErrorCodes.parentInvalid);
      currentParentId = parent.parentTaskId;
    }
    if (currentParentId !== null) throw new TaskError(taskErrorCodes.parentInvalid);
  }

  private async validateAssignees(
    database: Pick<PacaDatabase, "select">,
    projectId: string,
    assigneeIds: string[],
  ): Promise<void> {
    if (assigneeIds.length === 0) return;
    const rows = await database
      .select({ id: pacaProjectMembers.id })
      .from(pacaProjectMembers)
      .where(
        and(
          eq(pacaProjectMembers.projectId, projectId),
          inArray(pacaProjectMembers.id, assigneeIds),
        ),
      );
    if (rows.length !== assigneeIds.length) throw new TaskError(taskErrorCodes.assigneeInvalid);
  }

  private async validateCustomFields(
    database: Pick<PacaDatabase, "select">,
    projectId: string,
    values: Record<string, unknown>,
  ): Promise<void> {
    const definitions = await database
      .select()
      .from(pacaCustomFieldDefinitions)
      .where(eq(pacaCustomFieldDefinitions.projectId, projectId));
    const definitionsByKey = new Map(
      definitions.map((definition) => [definition.fieldKey, definition]),
    );
    if (Object.keys(values).some((key) => !definitionsByKey.has(key))) {
      throw new TaskError(taskErrorCodes.metadataInvalid);
    }
    for (const definition of definitions) {
      const value = values[definition.fieldKey];
      if (value === undefined || value === null || value === "") {
        if (definition.isRequired) throw new TaskError(taskErrorCodes.metadataInvalid);
        continue;
      }
      let valid = false;
      switch (definition.fieldType) {
        case "text":
          valid = typeof value === "string" && value.length <= 10_000;
          break;
        case "number":
          valid = typeof value === "number" && Number.isFinite(value);
          break;
        case "date":
          valid =
            typeof value === "string" &&
            /^\d{4}-\d{2}-\d{2}$/.test(value) &&
            !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
          break;
        case "select":
          valid = typeof value === "string" && definition.options.includes(value);
          break;
        case "multi_select":
          valid =
            Array.isArray(value) &&
            value.length <= 100 &&
            value.every((item) => typeof item === "string" && definition.options.includes(item));
          break;
        case "boolean":
          valid = typeof value === "boolean";
          break;
        case "url":
          if (typeof value === "string" && value.length <= 2_048) {
            try {
              const url = new URL(value);
              valid = url.protocol === "https:" || url.protocol === "http:";
            } catch {
              valid = false;
            }
          }
          break;
      }
      if (!valid) throw new TaskError(taskErrorCodes.metadataInvalid);
    }
  }
}
