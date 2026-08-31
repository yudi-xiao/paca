export const taskErrorCodes = {
  assigneeInvalid: "TASK_ASSIGNEE_INVALID",
  cursorInvalid: "TASK_CURSOR_INVALID",
  dateInvalid: "TASK_DATE_INVALID",
  filterInvalid: "TASK_FILTER_INVALID",
  descriptionInvalid: "TASK_DESCRIPTION_INVALID",
  importanceInvalid: "TASK_IMPORTANCE_INVALID",
  metadataInvalid: "TASK_METADATA_INVALID",
  notFound: "TASK_NOT_FOUND",
  parentInvalid: "TASK_PARENT_INVALID",
  sortInvalid: "TASK_SORT_INVALID",
  sprintInvalid: "TASK_SPRINT_INVALID",
  statusInvalid: "TASK_STATUS_INVALID",
  storyPointsInvalid: "TASK_STORY_POINTS_INVALID",
  sumFieldInvalid: "TASK_SUM_FIELD_INVALID",
  titleInvalid: "TASK_TITLE_INVALID",
  typeInvalid: "TASK_TYPE_INVALID",
} as const;

export type TaskErrorCode = (typeof taskErrorCodes)[keyof typeof taskErrorCodes];

export class TaskError extends Error {
  constructor(
    readonly code: TaskErrorCode,
    message = code,
  ) {
    super(message);
    this.name = "TaskError";
  }
}

export type TaskStatusCategory =
  | "backlog"
  | "refinement"
  | "ready"
  | "todo"
  | "inprogress"
  | "done";

export type TaskType = {
  id: string;
  projectId: string;
  name: string;
  icon: string | null;
  color: string | null;
  description: string | null;
  isDefault: boolean;
  isSystem: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type TaskStatus = {
  id: string;
  projectId: string;
  name: string;
  color: string | null;
  position: number;
  category: TaskStatusCategory;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type Task = {
  id: string;
  projectId: string;
  taskNumber: number;
  taskTypeId: string | null;
  statusId: string | null;
  sprintId: string | null;
  parentTaskId: string | null;
  title: string;
  description: unknown[] | null;
  importance: number;
  storyPoints: number | null;
  assigneeIds: string[];
  reporterId: string | null;
  customFields: Record<string, unknown>;
  startDate: string | null;
  dueDate: string | null;
  tags: string[];
  viewPosition: number | null;
  viewGroupKey: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type TaskList = {
  items: Task[];
  pageSize: number;
  nextCursor: string | null;
  totalCount: number;
  fieldSum: number | null;
};

export type CustomFieldFilterInput = {
  values?: string[];
  min?: number;
  max?: number;
  after?: string;
  before?: string;
  contains?: string;
};

export type IntRange = { min: number; max: number };

export type TaskListInput = {
  pageSize?: number;
  cursor?: string;
  search?: string;
  statusIds?: string[];
  sprintIds?: string[];
  assigneeIds?: string[];
  assigneeNull?: boolean;
  taskTypeIds?: string[];
  taskTypeNull?: boolean;
  parentTaskId?: string;
  sprintId?: string | null;
  sortBy?: string;
  viewId?: string;
  sumField?: string;
  customFieldFilters?: Record<string, CustomFieldFilterInput>;
  startDateAfter?: string;
  startDateBefore?: string;
  dueDateAfter?: string;
  dueDateBefore?: string;
  storyPointsMin?: number;
  storyPointsMax?: number;
  importanceRanges?: IntRange[];
  tags?: string[];
};

export type NormalizedTaskListInput = {
  pageSize: number;
  cursor: string | null;
  search: string | null;
  statusIds: string[];
  sprintIds: string[];
  assigneeIds: string[];
  assigneeNull: boolean;
  taskTypeIds: string[];
  taskTypeNull: boolean;
  parentTaskId: string | null;
  sprintId: string | null | undefined;
  sortBy: string | null;
  viewId: string | null;
  sumField: string | null;
  customFieldFilters: Record<string, CustomFieldFilterInput>;
  startDateAfter: string | null;
  startDateBefore: string | null;
  dueDateAfter: string | null;
  dueDateBefore: string | null;
  storyPointsMin: number | null;
  storyPointsMax: number | null;
  importanceRanges: IntRange[];
  tags: string[];
};

export type TaskCreateInput = {
  title: string;
  statusId?: string | null;
  sprintId?: string | null;
  taskTypeId?: string | null;
  parentTaskId?: string | null;
  description?: unknown;
  importance?: number;
  storyPoints?: number | null;
  assigneeIds?: string[];
  customFields?: unknown;
  startDate?: string | null;
  dueDate?: string | null;
  tags?: string[];
};

export type TaskUpdateInput = Partial<Omit<TaskCreateInput, "title">> & { title?: string };

/**
 * Trusted task mutation actor. Callers must construct this only from a
 * verified Better Auth Session or Agent Auth session, never from request JSON.
 */
export type TaskActor = { type: "user"; id: string } | { type: "agent"; id: string };

export function userTaskActor(id: string): TaskActor {
  return { type: "user", id };
}

export function agentTaskActor(id: string): TaskActor {
  return { type: "agent", id };
}

export type PersistedTaskCreate = {
  id: string;
  projectId: string;
  actor: TaskActor;
  title: string;
  statusId: string | null | undefined;
  sprintId: string | null | undefined;
  taskTypeId: string | null | undefined;
  parentTaskId: string | null | undefined;
  description: unknown[] | null;
  importance: number;
  storyPoints: number | null;
  assigneeIds: string[];
  customFields: Record<string, unknown>;
  startDate: string | null;
  dueDate: string | null;
  tags: string[];
};

export type PersistedTaskUpdate = Partial<
  Pick<
    Task,
    | "title"
    | "statusId"
    | "sprintId"
    | "taskTypeId"
    | "parentTaskId"
    | "description"
    | "importance"
    | "storyPoints"
    | "assigneeIds"
    | "customFields"
    | "startDate"
    | "dueDate"
    | "tags"
  >
>;

export interface TaskRepository {
  listTypes(projectId: string): Promise<TaskType[]>;
  listStatuses(projectId: string): Promise<TaskStatus[]>;
  list(projectId: string, input: NormalizedTaskListInput): Promise<TaskList>;
  findById(projectId: string, taskId: string): Promise<Task>;
  create(input: PersistedTaskCreate): Promise<Task>;
  update(
    projectId: string,
    taskId: string,
    actor: TaskActor,
    input: PersistedTaskUpdate,
  ): Promise<Task>;
  archive(projectId: string, taskId: string, actor: TaskActor): Promise<void>;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function normalizeTitle(value: string): string {
  const title = value.trim();
  if (title.length === 0 || title.length > 500) {
    throw new TaskError(taskErrorCodes.titleInvalid);
  }
  return title;
}

function normalizeDescription(value: unknown): unknown[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new TaskError(taskErrorCodes.descriptionInvalid);
  const serialized = JSON.stringify(value);
  if (serialized.length > 256_000) throw new TaskError(taskErrorCodes.descriptionInvalid);
  return JSON.parse(serialized) as unknown[];
}

function normalizeImportance(value: number | undefined): number {
  const importance = value ?? 0;
  if (!Number.isInteger(importance) || importance < 0 || importance > 1_000_000) {
    throw new TaskError(taskErrorCodes.importanceInvalid);
  }
  return importance;
}

function normalizeStoryPoints(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 0 || value > 1_000_000) {
    throw new TaskError(taskErrorCodes.storyPointsInvalid);
  }
  return value;
}

function normalizeDate(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (!DATE_PATTERN.test(value)) {
    throw new TaskError(taskErrorCodes.dateInvalid);
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year as number, (month as number) - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== (month as number) - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new TaskError(taskErrorCodes.dateInvalid);
  }
  return value;
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TaskError(taskErrorCodes.metadataInvalid);
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > 64_000) throw new TaskError(taskErrorCodes.metadataInvalid);
  return JSON.parse(serialized) as Record<string, unknown>;
}

function normalizeTags(value: string[] | undefined): string[] {
  if (value === undefined) return [];
  if (value.length > 50) throw new TaskError(taskErrorCodes.metadataInvalid);
  const tags = [...new Set(value.map((tag) => tag.trim()).filter(Boolean))];
  if (tags.some((tag) => tag.length > 100)) throw new TaskError(taskErrorCodes.metadataInvalid);
  return tags;
}

function normalizeAssignees(value: string[] | undefined): string[] {
  if (value === undefined) return [];
  const ids = [...new Set(value)];
  if (ids.length > 20) throw new TaskError(taskErrorCodes.assigneeInvalid);
  return ids;
}

export class TaskService {
  constructor(private readonly repository: TaskRepository) {}

  listTypes(projectId: string): Promise<TaskType[]> {
    return this.repository.listTypes(projectId);
  }

  listStatuses(projectId: string): Promise<TaskStatus[]> {
    return this.repository.listStatuses(projectId);
  }

  list(projectId: string, input: TaskListInput): Promise<TaskList> {
    const pageSize = Number.isInteger(input.pageSize)
      ? Math.min(Math.max(input.pageSize ?? 20, 1), 100)
      : 20;
    const cursor = input.cursor?.trim() || null;
    if (cursor !== null && cursor.length > 2_048) {
      throw new TaskError(taskErrorCodes.cursorInvalid);
    }
    const search = input.search?.trim().slice(0, 200) || null;
    const sortBy = input.sortBy?.trim() || null;
    const sumField = input.sumField?.trim() || null;
    const normalizedDate = (value: string | undefined) =>
      value === undefined ? null : normalizeDate(value);
    const storyPointsMin = input.storyPointsMin ?? null;
    const storyPointsMax = input.storyPointsMax ?? null;
    if (
      (storyPointsMin !== null && (!Number.isInteger(storyPointsMin) || storyPointsMin < 0)) ||
      (storyPointsMax !== null && (!Number.isInteger(storyPointsMax) || storyPointsMax < 0)) ||
      (storyPointsMin !== null && storyPointsMax !== null && storyPointsMin > storyPointsMax)
    ) {
      throw new TaskError(taskErrorCodes.filterInvalid);
    }
    const importanceRanges = (input.importanceRanges ?? []).slice(0, 20);
    if (
      importanceRanges.some(
        ({ min, max }) => !Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min,
      )
    ) {
      throw new TaskError(taskErrorCodes.filterInvalid);
    }
    const customFieldFilters = input.customFieldFilters ?? {};
    if (
      Object.keys(customFieldFilters).length > 50 ||
      Object.values(customFieldFilters).some((filter) => {
        if (filter.min !== undefined && !Number.isFinite(filter.min)) return true;
        if (filter.max !== undefined && !Number.isFinite(filter.max)) return true;
        if (filter.min !== undefined && filter.max !== undefined && filter.min > filter.max) {
          return true;
        }
        try {
          if (filter.after !== undefined) normalizeDate(filter.after);
          if (filter.before !== undefined) normalizeDate(filter.before);
        } catch {
          return true;
        }
        return false;
      })
    ) {
      throw new TaskError(taskErrorCodes.filterInvalid);
    }
    return this.repository.list(projectId, {
      pageSize,
      cursor,
      search,
      statusIds: [...new Set(input.statusIds ?? [])].slice(0, 50),
      sprintIds: [...new Set(input.sprintIds ?? [])].slice(0, 50),
      assigneeIds: [...new Set(input.assigneeIds ?? [])].slice(0, 50),
      assigneeNull: input.assigneeNull === true,
      taskTypeIds: [...new Set(input.taskTypeIds ?? [])].slice(0, 50),
      taskTypeNull: input.taskTypeNull === true,
      parentTaskId: input.parentTaskId ?? null,
      sprintId: input.sprintId,
      sortBy,
      viewId: input.viewId ?? null,
      sumField,
      customFieldFilters,
      startDateAfter: normalizedDate(input.startDateAfter),
      startDateBefore: normalizedDate(input.startDateBefore),
      dueDateAfter: normalizedDate(input.dueDateAfter),
      dueDateBefore: normalizedDate(input.dueDateBefore),
      storyPointsMin,
      storyPointsMax,
      importanceRanges,
      tags: normalizeTags(input.tags),
    });
  }

  get(projectId: string, taskId: string): Promise<Task> {
    return this.repository.findById(projectId, taskId);
  }

  create(projectId: string, actorUserId: string, input: TaskCreateInput): Promise<Task> {
    return this.createAs(projectId, userTaskActor(actorUserId), input);
  }

  createAs(projectId: string, actor: TaskActor, input: TaskCreateInput): Promise<Task> {
    return this.repository.create({
      id: crypto.randomUUID(),
      projectId,
      actor,
      title: normalizeTitle(input.title),
      statusId: input.statusId,
      sprintId: input.sprintId,
      taskTypeId: input.taskTypeId,
      parentTaskId: input.parentTaskId,
      description: normalizeDescription(input.description),
      importance: normalizeImportance(input.importance),
      storyPoints: normalizeStoryPoints(input.storyPoints),
      assigneeIds: normalizeAssignees(input.assigneeIds),
      customFields: normalizeMetadata(input.customFields),
      startDate: normalizeDate(input.startDate),
      dueDate: normalizeDate(input.dueDate),
      tags: normalizeTags(input.tags),
    });
  }

  async update(
    projectId: string,
    taskId: string,
    actorUserId: string,
    input: TaskUpdateInput,
  ): Promise<Task> {
    return this.updateAs(projectId, taskId, userTaskActor(actorUserId), input);
  }

  async updateAs(
    projectId: string,
    taskId: string,
    actor: TaskActor,
    input: TaskUpdateInput,
  ): Promise<Task> {
    const normalized: PersistedTaskUpdate = {};
    if (input.title !== undefined) normalized.title = normalizeTitle(input.title);
    if (input.statusId !== undefined) normalized.statusId = input.statusId;
    if (input.sprintId !== undefined) normalized.sprintId = input.sprintId;
    if (input.taskTypeId !== undefined) normalized.taskTypeId = input.taskTypeId;
    if (input.parentTaskId !== undefined) normalized.parentTaskId = input.parentTaskId;
    if (input.description !== undefined) {
      normalized.description = normalizeDescription(input.description);
    }
    if (input.importance !== undefined) {
      normalized.importance = normalizeImportance(input.importance);
    }
    if (input.storyPoints !== undefined) {
      normalized.storyPoints = normalizeStoryPoints(input.storyPoints);
    }
    if (input.assigneeIds !== undefined) {
      normalized.assigneeIds = normalizeAssignees(input.assigneeIds);
    }
    if (input.customFields !== undefined) {
      normalized.customFields = normalizeMetadata(input.customFields);
    }
    if (input.startDate !== undefined) normalized.startDate = normalizeDate(input.startDate);
    if (input.dueDate !== undefined) normalized.dueDate = normalizeDate(input.dueDate);
    if (input.tags !== undefined) normalized.tags = normalizeTags(input.tags);
    if (Object.keys(normalized).length === 0) return this.repository.findById(projectId, taskId);
    return this.repository.update(projectId, taskId, actor, normalized);
  }

  archive(projectId: string, taskId: string, actorUserId: string): Promise<void> {
    return this.archiveAs(projectId, taskId, userTaskActor(actorUserId));
  }

  archiveAs(projectId: string, taskId: string, actor: TaskActor): Promise<void> {
    return this.repository.archive(projectId, taskId, actor);
  }
}
