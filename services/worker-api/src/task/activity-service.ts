export const taskActivityErrorCodes = {
  commentForbidden: "TASK_COMMENT_FORBIDDEN",
  commentInvalid: "TASK_COMMENT_INVALID",
  commentNotFound: "TASK_COMMENT_NOT_FOUND",
  commentTypeInvalid: "TASK_COMMENT_TYPE_INVALID",
  taskNotFound: "TASK_NOT_FOUND",
} as const;

export type TaskActivityErrorCode =
  (typeof taskActivityErrorCodes)[keyof typeof taskActivityErrorCodes];

export class TaskActivityError extends Error {
  constructor(
    readonly code: TaskActivityErrorCode,
    message = code,
  ) {
    super(message);
    this.name = "TaskActivityError";
  }
}

export type TaskActivityActorType = "user" | "agent" | "system";

export type TaskActivity = {
  id: string;
  taskId: string;
  projectId: string;
  actorType: TaskActivityActorType;
  actorId: string;
  actorUserId: string | null;
  actorAgentId: string | null;
  actorMemberId: string | null;
  actorName: string;
  actorUsername: string;
  actorAvatarUrl: string | null;
  activityType: string;
  content: Record<string, unknown> | unknown[];
  createdAt: Date;
  updatedAt: Date;
};

export interface TaskActivityRepository {
  list(projectId: string, taskId: string): Promise<TaskActivity[]>;
  createComment(
    projectId: string,
    taskId: string,
    actorUserId: string,
    content: unknown[],
  ): Promise<TaskActivity>;
  updateComment(
    projectId: string,
    taskId: string,
    commentId: string,
    actorUserId: string,
    content: unknown[],
  ): Promise<TaskActivity>;
  deleteComment(
    projectId: string,
    taskId: string,
    commentId: string,
    actorUserId: string,
  ): Promise<void>;
}

function normalizeComment(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TaskActivityError(taskActivityErrorCodes.commentInvalid);
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > 64_000) {
    throw new TaskActivityError(taskActivityErrorCodes.commentInvalid);
  }
  return JSON.parse(serialized) as unknown[];
}

export class TaskActivityService {
  constructor(private readonly repository: TaskActivityRepository) {}

  list(projectId: string, taskId: string): Promise<TaskActivity[]> {
    return this.repository.list(projectId, taskId);
  }

  createComment(
    projectId: string,
    taskId: string,
    actorUserId: string,
    content: unknown,
  ): Promise<TaskActivity> {
    return this.repository.createComment(projectId, taskId, actorUserId, normalizeComment(content));
  }

  updateComment(
    projectId: string,
    taskId: string,
    commentId: string,
    actorUserId: string,
    content: unknown,
  ): Promise<TaskActivity> {
    return this.repository.updateComment(
      projectId,
      taskId,
      commentId,
      actorUserId,
      normalizeComment(content),
    );
  }

  deleteComment(
    projectId: string,
    taskId: string,
    commentId: string,
    actorUserId: string,
  ): Promise<void> {
    return this.repository.deleteComment(projectId, taskId, commentId, actorUserId);
  }
}
