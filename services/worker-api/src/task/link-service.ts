export const taskLinkErrorCodes = {
  crossProject: "TASK_LINK_CROSS_PROJECT",
  duplicate: "TASK_LINK_ALREADY_EXISTS",
  notFound: "TASK_LINK_NOT_FOUND",
  self: "TASK_LINK_CANNOT_LINK_TO_SELF",
  typeInvalid: "TASK_LINK_TYPE_INVALID",
} as const;

export type TaskLinkErrorCode = (typeof taskLinkErrorCodes)[keyof typeof taskLinkErrorCodes];

export class TaskLinkError extends Error {
  constructor(
    readonly code: TaskLinkErrorCode,
    message = code,
  ) {
    super(message);
    this.name = "TaskLinkError";
  }
}

export type LinkType = "blocks" | "relates_to" | "duplicates";

export type DisplayLinkType = LinkType | "is_blocked_by" | "is_duplicated_by";

export type LinkedTaskSummary = {
  id: string;
  taskNumber: number;
  title: string;
  statusId: string | null;
  taskTypeId: string | null;
};

export type TaskLink = {
  id: string;
  projectId: string;
  sourceTaskId: string;
  targetTaskId: string;
  linkType: LinkType;
  displayLinkType: DisplayLinkType;
  linkedTask: LinkedTaskSummary;
  createdBy: string | null;
  createdAt: Date;
};

export type TaskLinkCreateInput = {
  projectId: string;
  sourceTaskId: string;
  targetTaskId: string;
  linkType: LinkType;
  actorUserId: string;
};

export interface TaskLinkRepository {
  list(projectId: string, taskId: string): Promise<TaskLink[]>;
  create(input: TaskLinkCreateInput): Promise<TaskLink>;
  delete(projectId: string, taskId: string, linkId: string, actorUserId: string): Promise<void>;
}

const linkTypes = new Set<LinkType>(["blocks", "relates_to", "duplicates"]);

export class TaskLinkService {
  constructor(private readonly repository: TaskLinkRepository) {}

  list(projectId: string, taskId: string): Promise<TaskLink[]> {
    return this.repository.list(projectId, taskId);
  }

  create(input: TaskLinkCreateInput): Promise<TaskLink> {
    if (input.sourceTaskId === input.targetTaskId) {
      throw new TaskLinkError(taskLinkErrorCodes.self);
    }
    if (!linkTypes.has(input.linkType)) {
      throw new TaskLinkError(taskLinkErrorCodes.typeInvalid);
    }
    return this.repository.create(input);
  }

  delete(projectId: string, taskId: string, linkId: string, actorUserId: string): Promise<void> {
    return this.repository.delete(projectId, taskId, linkId, actorUserId);
  }
}
