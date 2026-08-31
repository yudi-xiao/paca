export const iterationErrorCodes = {
  dateInvalid: "SPRINT_DATE_INVALID",
  destinationInvalid: "SPRINT_DESTINATION_INVALID",
  nameInvalid: "SPRINT_NAME_INVALID",
  sprintAlreadyCompleted: "SPRINT_ALREADY_COMPLETED",
  sprintNotFound: "SPRINT_NOT_FOUND",
  statusInvalid: "SPRINT_STATUS_INVALID",
  taskPositionInvalid: "VIEW_TASK_POSITION_INVALID",
  viewConfigInvalid: "VIEW_CONFIG_INVALID",
  viewContextInvalid: "VIEW_CONTEXT_INVALID",
  viewIsLast: "VIEW_IS_LAST",
  viewNameInvalid: "VIEW_NAME_INVALID",
  viewNotFound: "VIEW_NOT_FOUND",
  viewReorderInvalid: "VIEW_REORDER_INVALID",
  viewTypeInvalid: "VIEW_TYPE_INVALID",
} as const;

export type IterationErrorCode = (typeof iterationErrorCodes)[keyof typeof iterationErrorCodes];

export class IterationError extends Error {
  constructor(
    readonly code: IterationErrorCode,
    message = code,
  ) {
    super(message);
    this.name = "IterationError";
  }
}

export const sprintStatuses = ["planned", "active", "completed"] as const;
export type SprintStatus = (typeof sprintStatuses)[number];

export const viewContexts = ["sprint", "backlog", "timeline"] as const;
export type ViewContext = (typeof viewContexts)[number];

export const viewTypes = ["table", "board", "roadmap", "plugin"] as const;
export type ViewType = (typeof viewTypes)[number];

export type Sprint = {
  id: string;
  projectId: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
  goal: string | null;
  status: SprintStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type TaskView = {
  id: string;
  sprintId: string | null;
  projectId: string;
  name: string;
  viewType: ViewType;
  viewContext: ViewContext;
  config: Record<string, unknown>;
  position: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ViewTaskPosition = {
  id: string;
  viewId: string;
  taskId: string;
  position: number;
  groupKey: string | null;
};

export type SprintCreateInput = {
  name: string;
  startDate?: string | null;
  endDate?: string | null;
  goal?: string | null;
  status?: SprintStatus;
};

export type SprintUpdateInput = {
  name?: string;
  startDate?: string | null;
  endDate?: string | null;
  goal?: string | null;
  status?: SprintStatus;
};

export type PersistedSprintCreate = {
  id: string;
  projectId: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
  goal: string | null;
  status: SprintStatus;
};

export type ViewCreateInput = {
  name: string;
  viewType?: ViewType;
  config?: Record<string, unknown>;
  position?: number;
};

export type ViewUpdateInput = {
  name?: string;
  viewType?: ViewType;
  config?: Record<string, unknown>;
  position?: number;
};

export type PersistedViewCreate = {
  id: string;
  projectId: string;
  sprintId: string | null;
  viewContext: ViewContext;
  name: string;
  viewType: ViewType;
  config: Record<string, unknown>;
  position: number | null;
};

export type TaskPositionInput = {
  taskId: string;
  position: number;
  groupKey?: string | null;
};

export interface IterationRepository {
  listSprints(projectId: string): Promise<Sprint[]>;
  findSprint(projectId: string, sprintId: string): Promise<Sprint>;
  createSprint(input: PersistedSprintCreate): Promise<Sprint>;
  updateSprint(projectId: string, sprintId: string, input: SprintUpdateInput): Promise<Sprint>;
  deleteSprint(projectId: string, sprintId: string, actorUserId: string): Promise<void>;
  completeSprint(
    projectId: string,
    sprintId: string,
    destinationSprintId: string | null,
    actorUserId: string,
  ): Promise<Sprint>;
  listViews(projectId: string, context: ViewContext, sprintId: string | null): Promise<TaskView[]>;
  findView(projectId: string, viewId: string): Promise<TaskView>;
  createView(input: PersistedViewCreate): Promise<TaskView>;
  updateView(projectId: string, viewId: string, input: ViewUpdateInput): Promise<TaskView>;
  deleteView(projectId: string, viewId: string): Promise<void>;
  reorderViews(
    projectId: string,
    context: ViewContext,
    sprintId: string | null,
    viewIds: string[],
  ): Promise<void>;
  listTaskPositions(projectId: string, viewId: string): Promise<ViewTaskPosition[]>;
  upsertTaskPositions(projectId: string, viewId: string, items: TaskPositionInput[]): Promise<void>;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function normalizeDate(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (!DATE_PATTERN.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new IterationError(iterationErrorCodes.dateInvalid);
  }
  return value;
}

function normalizeSprintName(value: string): string {
  const name = value.trim();
  if (name.length === 0 || name.length > 200) {
    throw new IterationError(iterationErrorCodes.nameInvalid);
  }
  return name;
}

function normalizeViewName(value: string): string {
  const name = value.trim();
  if (name.length === 0 || name.length > 100) {
    throw new IterationError(iterationErrorCodes.viewNameInvalid);
  }
  return name;
}

function normalizeGoal(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const goal = value.trim();
  if (goal.length > 10_000) throw new IterationError(iterationErrorCodes.nameInvalid);
  return goal || null;
}

function normalizeConfig(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (value === undefined) return {};
  const serialized = JSON.stringify(value);
  if (serialized.length > 64_000) {
    throw new IterationError(iterationErrorCodes.viewConfigInvalid);
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

function validatePluginConfig(type: ViewType, config: Record<string, unknown>): void {
  if (type !== "plugin") return;
  if (
    typeof config.plugin_manifest_id !== "string" ||
    !config.plugin_manifest_id.trim() ||
    typeof config.plugin_component !== "string" ||
    !config.plugin_component.trim()
  ) {
    throw new IterationError(iterationErrorCodes.viewConfigInvalid);
  }
}

function normalizePosition(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000_000) {
    throw new IterationError(iterationErrorCodes.taskPositionInvalid);
  }
  return value;
}

function validateDateRange(startDate: string | null, endDate: string | null): void {
  if (startDate !== null && endDate !== null && startDate > endDate) {
    throw new IterationError(iterationErrorCodes.dateInvalid);
  }
}

export class IterationService {
  constructor(private readonly repository: IterationRepository) {}

  listSprints(projectId: string): Promise<Sprint[]> {
    return this.repository.listSprints(projectId);
  }

  getSprint(projectId: string, sprintId: string): Promise<Sprint> {
    return this.repository.findSprint(projectId, sprintId);
  }

  createSprint(projectId: string, input: SprintCreateInput): Promise<Sprint> {
    const status = input.status ?? "planned";
    if (!sprintStatuses.includes(status)) {
      throw new IterationError(iterationErrorCodes.statusInvalid);
    }
    const startDate = normalizeDate(input.startDate);
    const endDate = normalizeDate(input.endDate);
    validateDateRange(startDate, endDate);
    return this.repository.createSprint({
      id: crypto.randomUUID(),
      projectId,
      name: normalizeSprintName(input.name),
      startDate,
      endDate,
      goal: normalizeGoal(input.goal),
      status,
    });
  }

  async updateSprint(
    projectId: string,
    sprintId: string,
    input: SprintUpdateInput,
  ): Promise<Sprint> {
    const current = await this.repository.findSprint(projectId, sprintId);
    const normalized: SprintUpdateInput = {};
    if (input.name !== undefined) normalized.name = normalizeSprintName(input.name);
    if (input.startDate !== undefined) normalized.startDate = normalizeDate(input.startDate);
    if (input.endDate !== undefined) normalized.endDate = normalizeDate(input.endDate);
    if (input.goal !== undefined) normalized.goal = normalizeGoal(input.goal);
    if (input.status !== undefined) {
      if (!sprintStatuses.includes(input.status)) {
        throw new IterationError(iterationErrorCodes.statusInvalid);
      }
      normalized.status = input.status;
    }
    const nextStart = normalized.startDate === undefined ? current.startDate : normalized.startDate;
    const nextEnd = normalized.endDate === undefined ? current.endDate : normalized.endDate;
    validateDateRange(nextStart, nextEnd);
    if (Object.keys(normalized).length === 0) return current;
    return this.repository.updateSprint(projectId, sprintId, normalized);
  }

  deleteSprint(projectId: string, sprintId: string, actorUserId: string): Promise<void> {
    return this.repository.deleteSprint(projectId, sprintId, actorUserId);
  }

  completeSprint(
    projectId: string,
    sprintId: string,
    destinationSprintId: string | null,
    actorUserId: string,
  ): Promise<Sprint> {
    if (destinationSprintId === sprintId) {
      throw new IterationError(iterationErrorCodes.destinationInvalid);
    }
    return this.repository.completeSprint(projectId, sprintId, destinationSprintId, actorUserId);
  }

  listViews(projectId: string, context: ViewContext, sprintId: string | null): Promise<TaskView[]> {
    if (!viewContexts.includes(context) || (context === "sprint") !== (sprintId !== null)) {
      throw new IterationError(iterationErrorCodes.viewContextInvalid);
    }
    return this.repository.listViews(projectId, context, sprintId);
  }

  getView(projectId: string, viewId: string): Promise<TaskView> {
    return this.repository.findView(projectId, viewId);
  }

  createView(
    projectId: string,
    context: ViewContext,
    sprintId: string | null,
    input: ViewCreateInput,
  ): Promise<TaskView> {
    if (!viewContexts.includes(context) || (context === "sprint") !== (sprintId !== null)) {
      throw new IterationError(iterationErrorCodes.viewContextInvalid);
    }
    const viewType = input.viewType ?? "table";
    if (!viewTypes.includes(viewType)) {
      throw new IterationError(iterationErrorCodes.viewTypeInvalid);
    }
    const config = normalizeConfig(input.config);
    validatePluginConfig(viewType, config);
    return this.repository.createView({
      id: crypto.randomUUID(),
      projectId,
      sprintId,
      viewContext: context,
      name: normalizeViewName(input.name),
      viewType,
      config,
      position: normalizePosition(input.position),
    });
  }

  async updateView(projectId: string, viewId: string, input: ViewUpdateInput): Promise<TaskView> {
    const current = await this.repository.findView(projectId, viewId);
    const normalized: ViewUpdateInput = {};
    if (input.name !== undefined) normalized.name = normalizeViewName(input.name);
    if (input.viewType !== undefined) {
      if (!viewTypes.includes(input.viewType)) {
        throw new IterationError(iterationErrorCodes.viewTypeInvalid);
      }
      normalized.viewType = input.viewType;
    }
    if (input.config !== undefined) normalized.config = normalizeConfig(input.config);
    if (input.position !== undefined) {
      normalized.position = normalizePosition(input.position) as number;
    }
    validatePluginConfig(
      normalized.viewType ?? current.viewType,
      normalized.config ?? current.config,
    );
    if (Object.keys(normalized).length === 0) return current;
    return this.repository.updateView(projectId, viewId, normalized);
  }

  deleteView(projectId: string, viewId: string): Promise<void> {
    return this.repository.deleteView(projectId, viewId);
  }

  reorderViews(
    projectId: string,
    context: ViewContext,
    sprintId: string | null,
    viewIds: string[],
  ): Promise<void> {
    if (
      !viewContexts.includes(context) ||
      (context === "sprint") !== (sprintId !== null) ||
      viewIds.length === 0 ||
      viewIds.length > 100 ||
      new Set(viewIds).size !== viewIds.length
    ) {
      throw new IterationError(iterationErrorCodes.viewReorderInvalid);
    }
    return this.repository.reorderViews(projectId, context, sprintId, viewIds);
  }

  listTaskPositions(projectId: string, viewId: string): Promise<ViewTaskPosition[]> {
    return this.repository.listTaskPositions(projectId, viewId);
  }

  upsertTaskPositions(
    projectId: string,
    viewId: string,
    items: TaskPositionInput[],
  ): Promise<void> {
    if (
      items.length === 0 ||
      items.length > 500 ||
      new Set(items.map((item) => item.taskId)).size !== items.length
    ) {
      throw new IterationError(iterationErrorCodes.taskPositionInvalid);
    }
    const normalized = items.map((item) => {
      const position = normalizePosition(item.position);
      const groupKey = item.groupKey?.trim() || null;
      if (position === null || (groupKey?.length ?? 0) > 255) {
        throw new IterationError(iterationErrorCodes.taskPositionInvalid);
      }
      return { taskId: item.taskId, position, groupKey };
    });
    return this.repository.upsertTaskPositions(projectId, viewId, normalized);
  }
}
