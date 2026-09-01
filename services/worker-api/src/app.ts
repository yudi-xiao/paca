import { Buffer } from "node:buffer";
import type { AgentSession } from "@better-auth/agent-auth";
import { type Context, Hono, type Next } from "hono";
import * as z from "zod";

import { exactConstraintString } from "./agent-auth/capabilities";
import { readPostgresProjectAsAgent } from "./agent-auth/execution";
import { type ReadAgentSession, requireAgentCapability } from "./agent-auth/http";
import { type AttachmentRuntime, attachmentRuntime } from "./attachment/runtime";
import {
  AttachmentError,
  type AttachmentUploadSession,
  attachmentErrorCodes,
  type TaskAttachment,
} from "./attachment/service";
import { protectAuthOrigin } from "./auth/origin";
import {
  type CurrentUserSession,
  handleAgentConfigurationRequest,
  handleAuthRequest,
  readCurrentAgentSession,
  readCurrentUserSession,
} from "./auth/runtime";
import type { AppBindings, AppVariables } from "./bindings";
import { type CustomFieldRuntime, customFieldRuntime } from "./custom-field/runtime";
import {
  type CustomFieldDefinition,
  CustomFieldError,
  customFieldErrorCodes,
} from "./custom-field/service";
import { checkDatabaseHealth, type DatabaseHealth, withDatabase } from "./database";
import { type DocumentRuntime, documentRuntime } from "./document/runtime";
import { DocumentError, documentErrorCodes, type PacaDocument } from "./document/service";
import { type IterationRuntime, iterationRuntime } from "./iteration/runtime";
import {
  IterationError,
  iterationErrorCodes,
  type Sprint,
  type TaskView,
  type ViewTaskPosition,
} from "./iteration/service";
import {
  type OrganizationAccessRuntime,
  organizationAccessRuntime,
} from "./organization/access-runtime";
import {
  OrganizationAccessError,
  type OrganizationMember,
  type OrganizationRole,
  organizationAccessErrorCodes,
} from "./organization/access-service";
import {
  type AuthorizeOrganizationPermission,
  type AuthorizeProjectPermission,
  type AuthorizeSystemPermission,
  authorizeOrganizationPermission,
  authorizeProjectPermission,
  authorizeSystemPermission,
  type LoadSystemPermissions,
  loadSystemPermissions,
  requireOrganizationPermission,
  requireOrganizationPermissionFromParam,
  requireProjectPermission,
  requireSystemPermission,
} from "./permission/http";
import { DEFAULT_ORGANIZATION_ID } from "./permission/postgres-store";
import { permissionGrantsToLegacyMap, toLegacyPermissionKey } from "./permission/statement";
import { type SystemRoleRuntime, systemRoleRuntime } from "./permission/system-role-runtime";
import {
  type SystemRole,
  SystemRoleError,
  systemRoleErrorCodes,
} from "./permission/system-role-service";
import { type ProjectAccessRuntime, projectAccessRuntime } from "./project/access-runtime";
import {
  ProjectAccessError,
  type ProjectMember,
  type ProjectRole,
  projectAccessErrorCodes,
  projectRolePermissions,
} from "./project/access-service";
import { type ProjectRuntime, projectRuntime } from "./project/runtime";
import { type Project, ProjectError, projectErrorCodes } from "./project/service";
import { constantTimeEqual, readBearerToken } from "./security";
import { type TaskActivityRuntime, taskActivityRuntime } from "./task/activity-runtime";
import {
  type TaskActivity,
  TaskActivityError,
  taskActivityErrorCodes,
} from "./task/activity-service";
import { type TaskLinkRuntime, taskLinkRuntime } from "./task/link-runtime";
import { type TaskLink, TaskLinkError, taskLinkErrorCodes } from "./task/link-service";
import { type TaskRuntime, taskRuntime } from "./task/runtime";
import {
  type Task,
  TaskError,
  type TaskStatus,
  type TaskType,
  taskErrorCodes,
} from "./task/service";

type LogLevel = "info" | "error";

type LogEvent = {
  level: LogLevel;
  message: string;
  requestId: string;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  errorName?: string;
};

type AppDependencies = {
  attachments: AttachmentRuntime;
  agentProject: (
    env: AppBindings,
    session: AgentSession,
    scope: { organizationId: string; projectId: string; validUntil: string },
  ) => Promise<Project>;
  agentConfigurationHandler: (request: Request, env: AppBindings) => Promise<Response>;
  authHandler: (request: Request, env: AppBindings) => Promise<Response>;
  authorizeOrganizationPermission: AuthorizeOrganizationPermission;
  authorizeProjectPermission: AuthorizeProjectPermission;
  authorizeSystemPermission: AuthorizeSystemPermission;
  currentUserSession: (request: Request, env: AppBindings) => Promise<CurrentUserSession | null>;
  currentAgentSession: ReadAgentSession;
  databaseHealth: (env: AppBindings) => Promise<DatabaseHealth>;
  customFields: CustomFieldRuntime;
  iterations: IterationRuntime;
  documents: DocumentRuntime;
  loadSystemPermissions: LoadSystemPermissions;
  log: (event: LogEvent) => void;
  organizationAccess: OrganizationAccessRuntime;
  projects: ProjectRuntime;
  projectAccess: ProjectAccessRuntime;
  systemRoles: SystemRoleRuntime;
  taskActivities: TaskActivityRuntime;
  taskLinks: TaskLinkRuntime;
  tasks: TaskRuntime;
};

type AppContext = Context<{
  Bindings: AppBindings;
  Variables: AppVariables;
}>;

async function requireValidProjectId(context: AppContext, next: Next) {
  if (!z.uuid().safeParse(context.req.param("projectId")).success) {
    return legacyFailure(context, 400, "BAD_REQUEST", "Invalid project id");
  }
  await next();
}

async function requireValidOrganizationId(context: AppContext, next: Next) {
  const organizationId = context.req.param("organizationId")?.trim();
  if (!organizationId || organizationId.length > 255) {
    return legacyFailure(context, 400, "BAD_REQUEST", "Invalid organization id");
  }
  await next();
}

function legacySuccess<T>(context: AppContext, data: T) {
  return context.json({
    success: true as const,
    data,
    request_id: context.get("requestId"),
  });
}

function legacyFailure(
  context: AppContext,
  status: 400 | 403 | 404 | 409 | 413 | 416 | 500,
  errorCode: string,
  error: string,
) {
  return context.json(
    {
      success: false as const,
      error_code: errorCode,
      error,
      request_id: context.get("requestId"),
    },
    status,
  );
}

const systemRoleBodySchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  permissions: z.record(z.string(), z.boolean()).default({}),
});

const systemRoleAssignmentBodySchema = z.object({
  role_ids: z.array(z.uuid()).min(1).max(32),
});

const projectCreateBodySchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  task_id_prefix: z.string().optional(),
  is_public: z.boolean().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

const projectUpdateBodySchema = projectCreateBodySchema
  .omit({ name: true })
  .extend({ name: z.string().optional() })
  .refine((body) => Object.keys(body).length > 0);

const projectListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().positive().max(100).default(50),
});

const projectRoleBodySchema = z.object({
  role_name: z.string(),
  description: z.string().optional(),
  permissions: z.record(z.string(), z.boolean()).default({}),
});

const projectMemberBodySchema = z.object({
  user_id: z.string().min(1).max(255),
  project_role_id: z.uuid(),
});

const projectMemberRoleBodySchema = z.object({
  project_role_id: z.uuid(),
});

const userListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().positive().max(100).default(20),
});

const organizationRoleBodySchema = z.object({
  role_name: z.string(),
  description: z.string().optional(),
  permissions: z.record(z.string(), z.boolean()).default({}),
});

const organizationMemberRolesBodySchema = z.object({
  role_ids: z.array(z.uuid()).min(1).max(32),
});

const taskListQuerySchema = z.object({
  page_size: z.coerce.number().int().positive().max(100).default(20),
  cursor: z.string().max(2_048).optional(),
  search: z.string().max(200).optional(),
  status_id: z.uuid().optional(),
  status_ids: z.string().max(2_000).optional(),
  sprint_ids: z.string().max(2_000).optional(),
  assignee_id: z.string().max(64).optional(),
  assignee_ids: z.string().max(2_000).optional(),
  task_type_id: z.string().max(64).optional(),
  task_type_ids: z.string().max(2_000).optional(),
  parent_task_id: z.uuid().optional(),
  sprint_id: z.string().max(64).optional(),
  sort_by: z.string().max(100).optional(),
  view_id: z.uuid().optional(),
  sum_field: z.string().max(100).optional(),
  custom_field_filters: z.string().max(16_000).optional(),
  start_date_after: z.string().max(10).optional(),
  start_date_before: z.string().max(10).optional(),
  due_date_after: z.string().max(10).optional(),
  due_date_before: z.string().max(10).optional(),
  story_points_min: z.coerce.number().int().min(0).max(1_000_000).optional(),
  story_points_max: z.coerce.number().int().min(0).max(1_000_000).optional(),
  importance_ranges: z.string().max(2_000).optional(),
  tags: z.string().max(5_000).optional(),
});

const customFieldFilterSchema = z.object({
  values: z.array(z.string().max(500)).max(100).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  after: z.string().max(10).optional(),
  before: z.string().max(10).optional(),
  contains: z.string().max(500).optional(),
});
const customFieldFiltersSchema = z.record(z.string().min(1).max(100), customFieldFilterSchema);
const importanceRangesSchema = z
  .array(z.object({ min: z.number().int().min(0), max: z.number().int().min(0) }))
  .max(20);

const taskCreateBodySchema = z.object({
  title: z.string(),
  status_id: z.uuid().nullable().optional(),
  task_type_id: z.uuid().nullable().optional(),
  sprint_id: z.uuid().nullable().optional(),
  parent_task_id: z.uuid().nullable().optional(),
  description: z.unknown().optional(),
  importance: z.number().optional(),
  story_points: z.number().nullable().optional(),
  assignee_ids: z.array(z.uuid()).max(20).optional(),
  custom_fields: z.record(z.string(), z.unknown()).optional(),
  start_date: z.string().nullable().optional(),
  due_date: z.string().nullable().optional(),
  tags: z.array(z.string()).max(50).optional(),
});

const taskUpdateBodySchema = taskCreateBodySchema
  .omit({ title: true })
  .extend({ title: z.string().optional() })
  .refine((body) => Object.keys(body).length > 0);

const documentCreateBodySchema = z
  .object({
    title: z.string().optional(),
    content: z.array(z.unknown()).nullable().optional(),
    position: z.number().int().optional(),
  })
  .strict();

const documentUpdateBodySchema = documentCreateBodySchema.refine(
  (body) => Object.keys(body).length > 0,
);

const documentBootstrapBodySchema = z
  .object({
    update_base64: z.string().min(1).max(350_000),
  })
  .strict();

const taskCommentBodySchema = z.object({
  content: z.array(z.unknown()).min(1),
});

const taskLinkBodySchema = z.object({
  target_task_id: z.uuid(),
  link_type: z.enum(["blocks", "relates_to", "duplicates"]),
});

const attachmentInitiateBodySchema = z.object({
  file_name: z.string(),
  content_type: z.string(),
  file_size: z.number().int(),
});

const attachmentCompleteBodySchema = z.object({
  file_id: z.uuid(),
  upload_id: z.string().min(1).max(2_048).nullable().optional(),
  parts: z
    .array(
      z.object({
        part_number: z.number().int().positive().max(10_000),
        etag: z.string().min(1).max(256),
      }),
    )
    .max(10_000)
    .optional(),
});

const customFieldCreateBodySchema = z.object({
  field_key: z.string(),
  display_name: z.string(),
  field_type: z.enum(["text", "number", "date", "select", "multi_select", "boolean", "url"]),
  options: z.array(z.string()).max(100).optional(),
  is_required: z.boolean().optional(),
});

const customFieldUpdateBodySchema = z
  .object({
    display_name: z.string().optional(),
    options: z.array(z.string()).max(100).optional(),
    is_required: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0);

const sprintCreateBodySchema = z.object({
  name: z.string(),
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
  goal: z.string().nullable().optional(),
  status: z.enum(["planned", "active", "completed"]).optional(),
});

const sprintUpdateBodySchema = sprintCreateBodySchema
  .omit({ name: true })
  .extend({ name: z.string().optional() })
  .refine((body) => Object.keys(body).length > 0);

const sprintCompleteBodySchema = z.object({
  move_to_sprint_id: z.uuid().nullable().optional(),
});

const viewQuerySchema = z.object({
  context: z.enum(["sprint", "backlog", "timeline"]).default("sprint"),
  sprint_id: z.uuid().optional(),
});

const viewCreateBodySchema = z.object({
  name: z.string(),
  view_type: z.enum(["table", "board", "roadmap", "plugin"]).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  position: z.number().optional(),
});

const viewUpdateBodySchema = viewCreateBodySchema
  .omit({ name: true })
  .extend({ name: z.string().optional() })
  .refine((body) => Object.keys(body).length > 0);

const viewReorderBodySchema = z.object({
  view_ids: z.array(z.uuid()).min(1).max(100),
});

const taskPositionBodySchema = z.object({
  position: z.number(),
  group_key: z.string().nullable().optional(),
});

const taskPositionsBodySchema = z.object({
  items: z
    .array(
      z.object({
        task_id: z.uuid(),
        position: z.number(),
        group_key: z.string().nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
});

async function readSystemRoleBody(context: AppContext) {
  const body = await context.req.json().catch(() => null);
  const parsed = systemRoleBodySchema.safeParse(body);
  if (!parsed.success) return null;
  return parsed.data;
}

function systemRoleResponse(role: SystemRole) {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    permissions: permissionGrantsToLegacyMap(role.grants),
    is_built_in: role.isBuiltIn,
    created_at: role.createdAt.toISOString(),
    updated_at: role.updatedAt.toISOString(),
  };
}

function systemRoleFailure(context: AppContext, error: unknown) {
  if (!(error instanceof SystemRoleError)) throw error;

  switch (error.code) {
    case systemRoleErrorCodes.assignmentInvalid:
    case systemRoleErrorCodes.descriptionInvalid:
    case systemRoleErrorCodes.nameInvalid:
    case systemRoleErrorCodes.permissionsInvalid:
      return legacyFailure(context, 400, error.code, error.message);
    case systemRoleErrorCodes.permissionEscalation:
      return legacyFailure(context, 403, error.code, error.message);
    case systemRoleErrorCodes.notFound:
    case systemRoleErrorCodes.userNotFound:
      return legacyFailure(context, 404, error.code, error.message);
    case systemRoleErrorCodes.assigned:
    case systemRoleErrorCodes.builtIn:
    case systemRoleErrorCodes.nameTaken:
    case systemRoleErrorCodes.lastSuperAdmin:
      return legacyFailure(context, 409, error.code, error.message);
  }
}

function projectResponse(project: Project) {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    task_id_prefix: project.taskIdPrefix,
    is_public: project.isPublic,
    settings: project.settings,
    created_by: project.createdBy,
    created_at: project.createdAt.toISOString(),
    updated_at: project.updatedAt.toISOString(),
  };
}

function projectFailure(context: AppContext, error: unknown) {
  if (!(error instanceof ProjectError)) throw error;

  switch (error.code) {
    case projectErrorCodes.descriptionInvalid:
    case projectErrorCodes.nameInvalid:
    case projectErrorCodes.prefixInvalid:
    case projectErrorCodes.settingsInvalid:
      return legacyFailure(context, 400, error.code, error.message);
    case projectErrorCodes.notFound:
      return legacyFailure(context, 404, error.code, error.message);
    case projectErrorCodes.nameTaken:
      return legacyFailure(context, 409, error.code, error.message);
  }
}

function taskTypeResponse(taskType: TaskType) {
  return {
    id: taskType.id,
    project_id: taskType.projectId,
    name: taskType.name,
    icon: taskType.icon,
    color: taskType.color,
    description: taskType.description,
    is_default: taskType.isDefault,
    is_system: taskType.isSystem,
    created_at: taskType.createdAt.toISOString(),
    updated_at: taskType.updatedAt.toISOString(),
  };
}

function taskStatusResponse(status: TaskStatus) {
  return {
    id: status.id,
    project_id: status.projectId,
    name: status.name,
    color: status.color,
    position: status.position,
    category: status.category,
    is_default: status.isDefault,
    created_at: status.createdAt.toISOString(),
    updated_at: status.updatedAt.toISOString(),
  };
}

function taskResponse(task: Task) {
  return {
    id: task.id,
    project_id: task.projectId,
    task_number: task.taskNumber,
    task_type_id: task.taskTypeId,
    status_id: task.statusId,
    sprint_id: task.sprintId,
    parent_task_id: task.parentTaskId,
    title: task.title,
    description: task.description,
    importance: task.importance,
    story_points: task.storyPoints,
    assignee_ids: task.assigneeIds,
    reporter_id: task.reporterId,
    custom_fields: task.customFields,
    start_date: task.startDate,
    due_date: task.dueDate,
    tags: task.tags,
    view_position: task.viewPosition,
    view_group_key: task.viewGroupKey,
    created_at: task.createdAt.toISOString(),
    updated_at: task.updatedAt.toISOString(),
  };
}

function documentResponse(document: PacaDocument) {
  return {
    id: document.id,
    project_id: document.projectId,
    folder_id: null,
    title: document.title,
    content: document.content,
    content_version: document.contentVersion,
    position: document.position,
    created_by: document.createdBy,
    updated_by: document.updatedBy,
    created_at: document.createdAt.toISOString(),
    updated_at: document.updatedAt.toISOString(),
  };
}

function documentFailure(context: AppContext, error: unknown) {
  if (!(error instanceof DocumentError)) throw error;
  switch (error.code) {
    case documentErrorCodes.contentInvalid:
    case documentErrorCodes.positionInvalid:
    case documentErrorCodes.titleInvalid:
      return legacyFailure(context, 400, error.code, error.message);
    case documentErrorCodes.notFound:
      return legacyFailure(context, 404, error.code, error.message);
  }
}

function decodeDocumentBootstrapUpdate(value: string): ArrayBuffer | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null;
  }
  try {
    const bytes = Buffer.from(value, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > 256 * 1024) return null;
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  } catch {
    return null;
  }
}

function taskLinkResponse(link: TaskLink) {
  return {
    id: link.id,
    source_task_id: link.sourceTaskId,
    target_task_id: link.targetTaskId,
    link_type: link.linkType,
    display_link_type: link.displayLinkType,
    linked_task: {
      id: link.linkedTask.id,
      task_number: link.linkedTask.taskNumber,
      title: link.linkedTask.title,
      status_id: link.linkedTask.statusId,
      task_type_id: link.linkedTask.taskTypeId,
    },
    created_by: link.createdBy,
    created_at: link.createdAt.toISOString(),
  };
}

function customFieldResponse(field: CustomFieldDefinition) {
  return {
    id: field.id,
    project_id: field.projectId,
    field_key: field.fieldKey,
    display_name: field.displayName,
    field_type: field.fieldType,
    options: field.options,
    is_required: field.isRequired,
    created_at: field.createdAt.toISOString(),
    updated_at: field.updatedAt.toISOString(),
  };
}

function customFieldFailure(context: AppContext, error: unknown) {
  if (!(error instanceof CustomFieldError)) throw error;
  switch (error.code) {
    case customFieldErrorCodes.keyInvalid:
    case customFieldErrorCodes.nameInvalid:
    case customFieldErrorCodes.optionsInvalid:
    case customFieldErrorCodes.typeInvalid:
      return legacyFailure(context, 400, error.code, error.message);
    case customFieldErrorCodes.notFound:
      return legacyFailure(context, 404, error.code, error.message);
    case customFieldErrorCodes.keyTaken:
      return legacyFailure(context, 409, error.code, error.message);
  }
}

function sprintResponse(sprint: Sprint) {
  return {
    id: sprint.id,
    project_id: sprint.projectId,
    name: sprint.name,
    start_date: sprint.startDate,
    end_date: sprint.endDate,
    goal: sprint.goal,
    status: sprint.status,
    created_at: sprint.createdAt.toISOString(),
    updated_at: sprint.updatedAt.toISOString(),
  };
}

function viewResponse(view: TaskView) {
  return {
    id: view.id,
    sprint_id: view.sprintId,
    project_id: view.projectId,
    name: view.name,
    view_type: view.viewType,
    config: view.config,
    position: view.position,
    created_at: view.createdAt.toISOString(),
    updated_at: view.updatedAt.toISOString(),
  };
}

function taskPositionResponse(position: ViewTaskPosition) {
  return {
    view_id: position.viewId,
    task_id: position.taskId,
    position: position.position,
    group_key: position.groupKey,
  };
}

function iterationFailure(context: AppContext, error: unknown) {
  if (!(error instanceof IterationError)) throw error;
  switch (error.code) {
    case iterationErrorCodes.dateInvalid:
    case iterationErrorCodes.nameInvalid:
    case iterationErrorCodes.statusInvalid:
    case iterationErrorCodes.taskPositionInvalid:
    case iterationErrorCodes.viewConfigInvalid:
    case iterationErrorCodes.viewContextInvalid:
    case iterationErrorCodes.viewNameInvalid:
    case iterationErrorCodes.viewReorderInvalid:
    case iterationErrorCodes.viewTypeInvalid:
      return legacyFailure(context, 400, error.code, error.message);
    case iterationErrorCodes.sprintNotFound:
    case iterationErrorCodes.viewNotFound:
      return legacyFailure(context, 404, error.code, error.message);
    case iterationErrorCodes.destinationInvalid:
    case iterationErrorCodes.sprintAlreadyCompleted:
    case iterationErrorCodes.viewIsLast:
      return legacyFailure(context, 409, error.code, error.message);
  }
}

function taskActivityResponse(activity: TaskActivity) {
  return {
    id: activity.id,
    task_id: activity.taskId,
    actor_type: activity.actorType,
    actor_id: activity.actorId,
    actor_user_id: activity.actorUserId,
    actor_agent_id: activity.actorAgentId,
    actor_member_id: activity.actorMemberId,
    actor_name: activity.actorName,
    actor_username: activity.actorUsername,
    actor_avatar_url: activity.actorAvatarUrl,
    actor_avatar_thumb_url: activity.actorAvatarUrl,
    activity_type: activity.activityType,
    content: activity.content,
    created_at: activity.createdAt.toISOString(),
    updated_at: activity.updatedAt.toISOString(),
  };
}

function taskActivityFailure(context: AppContext, error: unknown) {
  if (!(error instanceof TaskActivityError)) throw error;
  switch (error.code) {
    case taskActivityErrorCodes.commentInvalid:
      return legacyFailure(context, 400, error.code, error.message);
    case taskActivityErrorCodes.commentForbidden:
      return legacyFailure(context, 403, error.code, error.message);
    case taskActivityErrorCodes.commentNotFound:
    case taskActivityErrorCodes.taskNotFound:
      return legacyFailure(context, 404, error.code, error.message);
    case taskActivityErrorCodes.commentTypeInvalid:
      return legacyFailure(context, 409, error.code, error.message);
  }
}

function attachmentResponse(attachment: TaskAttachment) {
  return {
    id: attachment.id,
    task_id: attachment.taskId,
    file_id: attachment.fileId,
    created_by: attachment.createdBy,
    created_at: attachment.createdAt.toISOString(),
    file: {
      id: attachment.file.id,
      file_name: attachment.file.fileName,
      content_type: attachment.file.contentType,
      file_size: attachment.file.actualSize ?? attachment.file.declaredSize,
      sha256: attachment.file.sha256,
      etag: attachment.file.etag,
      created_at: attachment.file.createdAt.toISOString(),
    },
    deleted_at: attachment.deletedAt?.toISOString() ?? null,
    purge_after: attachment.purgeAfter?.toISOString() ?? null,
  };
}

function attachmentUploadSessionResponse(session: AttachmentUploadSession) {
  return {
    file_id: session.fileId,
    is_multipart: session.isMultipart,
    upload_url: session.uploadUrl,
    multipart: session.multipart
      ? {
          upload_id: session.multipart.uploadId,
          parts: session.multipart.parts.map((part) => ({
            part_number: part.partNumber,
            upload_url: part.uploadUrl,
          })),
        }
      : undefined,
  };
}

function attachmentFailure(context: AppContext, error: unknown) {
  if (!(error instanceof AttachmentError)) throw error;
  switch (error.code) {
    case attachmentErrorCodes.contentTypeInvalid:
    case attachmentErrorCodes.fileNameInvalid:
    case attachmentErrorCodes.multipartInvalid:
      return legacyFailure(context, 400, error.code, error.message);
    case attachmentErrorCodes.uploadForbidden:
      return legacyFailure(context, 403, error.code, error.message);
    case attachmentErrorCodes.attachmentNotFound:
    case attachmentErrorCodes.fileNotFound:
    case attachmentErrorCodes.objectMissing:
    case attachmentErrorCodes.taskNotFound:
      return legacyFailure(context, 404, error.code, error.message);
    case attachmentErrorCodes.uploadNotPending:
    case attachmentErrorCodes.uploadSizeMismatch:
    case attachmentErrorCodes.attachmentRestoreUnavailable:
      return legacyFailure(context, 409, error.code, error.message);
    case attachmentErrorCodes.sizeInvalid:
      return legacyFailure(context, 413, error.code, error.message);
    case attachmentErrorCodes.rangeInvalid:
      return legacyFailure(context, 416, error.code, error.message);
  }
}

function contentLength(request: Request): number | null {
  const raw = request.headers.get("content-length");
  if (!raw || !/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function attachmentDisposition(fileName: string, mode: "attachment" | "inline"): string {
  const ascii =
    fileName
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\/]/g, "_")
      .trim() || "file";
  return `${mode}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function canPreviewAttachment(contentType: string): boolean {
  return new Set([
    "application/pdf",
    "image/avif",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
    "text/plain",
  ]).has(contentType);
}

function taskFailure(context: AppContext, error: unknown) {
  if (!(error instanceof TaskError)) throw error;
  switch (error.code) {
    case taskErrorCodes.notFound:
      return legacyFailure(context, 404, error.code, error.message);
    case taskErrorCodes.assigneeInvalid:
    case taskErrorCodes.cursorInvalid:
    case taskErrorCodes.dateInvalid:
    case taskErrorCodes.descriptionInvalid:
    case taskErrorCodes.filterInvalid:
    case taskErrorCodes.importanceInvalid:
    case taskErrorCodes.metadataInvalid:
    case taskErrorCodes.parentInvalid:
    case taskErrorCodes.sortInvalid:
    case taskErrorCodes.sprintInvalid:
    case taskErrorCodes.statusInvalid:
    case taskErrorCodes.storyPointsInvalid:
    case taskErrorCodes.sumFieldInvalid:
    case taskErrorCodes.titleInvalid:
    case taskErrorCodes.typeInvalid:
      return legacyFailure(context, 400, error.code, error.message);
  }
}

function taskLinkFailure(context: AppContext, error: unknown) {
  if (error instanceof TaskError) return taskFailure(context, error);
  if (!(error instanceof TaskLinkError)) throw error;
  switch (error.code) {
    case taskLinkErrorCodes.notFound:
      return legacyFailure(context, 404, error.code, error.message);
    case taskLinkErrorCodes.crossProject:
    case taskLinkErrorCodes.self:
    case taskLinkErrorCodes.typeInvalid:
      return legacyFailure(context, 400, error.code, error.message);
    case taskLinkErrorCodes.duplicate:
      return legacyFailure(context, 409, error.code, error.message);
  }
}

function commaSeparatedUuids(value: string | undefined): string[] | null {
  if (!value) return [];
  const values = [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  return values.length <= 50 && values.every((item) => z.uuid().safeParse(item).success)
    ? values
    : null;
}

function projectRoleResponse(role: ProjectRole) {
  return {
    id: role.id,
    project_id: role.projectId,
    role_name: role.name,
    description: role.description,
    permissions: projectRolePermissions(role),
    is_built_in: role.isBuiltIn,
    created_at: role.createdAt.toISOString(),
    updated_at: role.updatedAt.toISOString(),
  };
}

function projectMemberResponse(member: ProjectMember) {
  return {
    id: member.id,
    project_id: member.projectId,
    user_id: member.userId,
    project_role_id: member.role.id,
    username: member.userEmail.split("@")[0] || member.userName,
    full_name: member.userName,
    role_name: member.role.name,
    member_type: "human",
    avatar_url: member.userImage,
    avatar_thumb_url: member.userImage,
    created_at: member.createdAt.toISOString(),
  };
}

function projectAccessFailure(context: AppContext, error: unknown) {
  if (!(error instanceof ProjectAccessError)) throw error;

  switch (error.code) {
    case projectAccessErrorCodes.roleNameInvalid:
    case projectAccessErrorCodes.permissionsInvalid:
      return legacyFailure(context, 400, error.code, error.message);
    case projectAccessErrorCodes.permissionEscalation:
      return legacyFailure(context, 403, error.code, error.message);
    case projectAccessErrorCodes.roleNotFound:
    case projectAccessErrorCodes.memberNotFound:
    case projectAccessErrorCodes.userNotFound:
      return legacyFailure(context, 404, error.code, error.message);
    case projectAccessErrorCodes.roleAssigned:
    case projectAccessErrorCodes.roleBuiltIn:
    case projectAccessErrorCodes.roleNameTaken:
    case projectAccessErrorCodes.memberAlreadyAdded:
    case projectAccessErrorCodes.lastAdmin:
      return legacyFailure(context, 409, error.code, error.message);
  }
}

function organizationRoleResponse(role: OrganizationRole) {
  return {
    id: role.id,
    organization_id: role.organizationId,
    role_name: role.name,
    description: role.description,
    permissions: permissionGrantsToLegacyMap(role.grants),
    is_built_in: role.isBuiltIn,
    created_at: role.createdAt.toISOString(),
    updated_at: role.updatedAt.toISOString(),
  };
}

function organizationMemberResponse(member: OrganizationMember) {
  return {
    id: member.id,
    organization_id: member.organizationId,
    user_id: member.userId,
    username: member.userEmail.split("@")[0] || member.userName,
    full_name: member.userName,
    email: member.userEmail,
    avatar_url: member.userImage,
    avatar_thumb_url: member.userImage,
    roles: member.roles.map(organizationRoleResponse),
    created_at: member.createdAt.toISOString(),
  };
}

function organizationAccessFailure(context: AppContext, error: unknown) {
  if (!(error instanceof OrganizationAccessError)) throw error;

  switch (error.code) {
    case organizationAccessErrorCodes.assignmentInvalid:
    case organizationAccessErrorCodes.permissionsInvalid:
    case organizationAccessErrorCodes.roleDescriptionInvalid:
    case organizationAccessErrorCodes.roleNameInvalid:
      return legacyFailure(context, 400, error.code, error.message);
    case organizationAccessErrorCodes.permissionEscalation:
      return legacyFailure(context, 403, error.code, error.message);
    case organizationAccessErrorCodes.memberNotFound:
    case organizationAccessErrorCodes.roleNotFound:
      return legacyFailure(context, 404, error.code, error.message);
    case organizationAccessErrorCodes.lastOwner:
    case organizationAccessErrorCodes.roleAssigned:
    case organizationAccessErrorCodes.roleBuiltIn:
    case organizationAccessErrorCodes.roleNameTaken:
      return legacyFailure(context, 409, error.code, error.message);
  }
}

async function authenticatedPreviewResponse<T>(
  context: AppContext,
  currentUserSession: AppDependencies["currentUserSession"],
  data: T,
) {
  const session = await currentUserSession(context.req.raw, context.env);
  if (!session) {
    return context.json(
      {
        success: false as const,
        error_code: "AUTH_UNAUTHENTICATED",
        error: "Authentication required",
        request_id: context.get("requestId"),
      },
      401,
    );
  }

  return legacySuccess(context, data);
}

function agentProjectScope(session: AgentSession, projectId: string) {
  const grant = session.agent.capabilityGrants.find(
    (candidate) => candidate.capability === "project.read" && candidate.status === "active",
  );
  const organizationId = exactConstraintString(grant?.constraints?.organizationId);
  const validUntil = exactConstraintString(grant?.constraints?.validUntil);
  if (!organizationId || !validUntil) return null;
  return { organizationId, projectId, validUntil };
}

const defaultDependencies: AppDependencies = {
  attachments: attachmentRuntime,
  agentProject: (env, session, scope) =>
    withDatabase(env, (database) => readPostgresProjectAsAgent(database, session, scope)),
  agentConfigurationHandler: handleAgentConfigurationRequest,
  authHandler: handleAuthRequest,
  authorizeOrganizationPermission,
  authorizeProjectPermission,
  authorizeSystemPermission,
  currentUserSession: readCurrentUserSession,
  currentAgentSession: readCurrentAgentSession,
  customFields: customFieldRuntime,
  databaseHealth: checkDatabaseHealth,
  documents: documentRuntime,
  iterations: iterationRuntime,
  loadSystemPermissions,
  log(event) {
    const serialized = JSON.stringify(event);
    if (event.level === "error") {
      console.error(serialized);
      return;
    }
    console.log(serialized);
  },
  organizationAccess: organizationAccessRuntime,
  projects: projectRuntime,
  projectAccess: projectAccessRuntime,
  systemRoles: systemRoleRuntime,
  taskActivities: taskActivityRuntime,
  taskLinks: taskLinkRuntime,
  tasks: taskRuntime,
};

export function createApp(overrides: Partial<AppDependencies> = {}) {
  const dependencies: AppDependencies = { ...defaultDependencies, ...overrides };
  const app = new Hono<{ Bindings: AppBindings; Variables: AppVariables }>();

  app.use("*", async (context, next) => {
    const requestId = context.req.header("x-request-id") ?? crypto.randomUUID();
    const startedAt = performance.now();
    context.set("requestId", requestId);
    context.header("x-request-id", requestId);

    try {
      await next();
    } finally {
      dependencies.log({
        level: "info",
        message: "request.completed",
        requestId,
        method: context.req.method,
        path: new URL(context.req.url).pathname,
        status: context.res.status,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      });
    }
  });

  app.get("/health", (context) =>
    context.json({
      status: "ok",
      service: "paca-worker-api",
      environment: context.env.ENVIRONMENT,
      requestId: context.get("requestId"),
    }),
  );

  app.use("/api/auth/*", protectAuthOrigin);
  app.on(["GET", "POST"], "/api/auth/*", (context) =>
    dependencies.authHandler(context.req.raw, context.env),
  );

  app.get("/.well-known/agent-configuration", (context) =>
    dependencies.agentConfigurationHandler(context.req.raw, context.env),
  );

  app.get(
    "/api/v1/agent/projects/:projectId",
    requireValidProjectId,
    requireAgentCapability(dependencies.currentAgentSession, "project.read", (request) => ({
      projectId: request.param("projectId"),
    })),
    async (context) => {
      const projectId = context.req.param("projectId");
      const session = context.get("agentSession");
      const scope = agentProjectScope(session, projectId);
      if (!scope) {
        return legacyFailure(
          context,
          403,
          "AGENT_GRANT_CONSTRAINTS_INVALID",
          "Agent capability denied",
        );
      }

      try {
        return legacySuccess(
          context,
          projectResponse(await dependencies.agentProject(context.env, session, scope)),
        );
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("AGENT_")) {
          return legacyFailure(context, 403, error.message, "Agent capability denied");
        }
        return projectFailure(context, error);
      }
    },
  );

  app.get("/api/me", async (context) => {
    context.header("cache-control", "no-store");
    const session = await dependencies.currentUserSession(context.req.raw, context.env);
    if (!session) {
      return context.json(
        {
          status: "unauthorized",
          code: "UNAUTHENTICATED",
          requestId: context.get("requestId"),
        },
        401,
      );
    }

    return context.json({
      status: "ok",
      data: session,
      requestId: context.get("requestId"),
    });
  });

  // Temporary internal-preview bridge for React surfaces whose domain implementations have not
  // moved yet. Authentication still uses Better Auth as the sole authority.
  app.get("/api/v1/branding", (context) => legacySuccess(context, {}));
  app.get("/api/v1/version", (context) =>
    legacySuccess(context, { current: "cloudflare-internal-preview" }),
  );
  app.get(
    "/api/v1/organizations/:organizationId/roles",
    requireValidOrganizationId,
    requireOrganizationPermissionFromParam(dependencies.authorizeOrganizationPermission, {
      organizationRoles: ["read"],
    }),
    async (context) => {
      try {
        const roles = await dependencies.organizationAccess.listRoles(
          context.env,
          context.req.param("organizationId"),
        );
        return legacySuccess(context, roles.map(organizationRoleResponse));
      } catch (error) {
        return organizationAccessFailure(context, error);
      }
    },
  );
  app.post(
    "/api/v1/organizations/:organizationId/roles",
    requireValidOrganizationId,
    requireOrganizationPermissionFromParam(dependencies.authorizeOrganizationPermission, {
      organizationRoles: ["write"],
    }),
    async (context) => {
      const parsed = organizationRoleBodySchema.safeParse(
        await context.req.json().catch(() => null),
      );
      if (!parsed.success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid organization role");
      }
      try {
        const role = await dependencies.organizationAccess.createRole(
          context.env,
          context.get("permissionGrants"),
          context.req.param("organizationId"),
          {
            name: parsed.data.role_name,
            description: parsed.data.description,
            permissions: parsed.data.permissions,
          },
        );
        return context.json(
          {
            success: true as const,
            data: organizationRoleResponse(role),
            request_id: context.get("requestId"),
          },
          201,
        );
      } catch (error) {
        return organizationAccessFailure(context, error);
      }
    },
  );
  app.patch(
    "/api/v1/organizations/:organizationId/roles/:roleId",
    requireValidOrganizationId,
    requireOrganizationPermissionFromParam(dependencies.authorizeOrganizationPermission, {
      organizationRoles: ["write"],
    }),
    async (context) => {
      const roleId = context.req.param("roleId");
      const parsed = organizationRoleBodySchema.safeParse(
        await context.req.json().catch(() => null),
      );
      if (!z.uuid().safeParse(roleId).success || !parsed.success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid organization role");
      }
      try {
        const role = await dependencies.organizationAccess.updateRole(
          context.env,
          context.get("permissionGrants"),
          context.req.param("organizationId"),
          roleId,
          {
            name: parsed.data.role_name,
            description: parsed.data.description,
            permissions: parsed.data.permissions,
          },
        );
        return legacySuccess(context, organizationRoleResponse(role));
      } catch (error) {
        return organizationAccessFailure(context, error);
      }
    },
  );
  app.delete(
    "/api/v1/organizations/:organizationId/roles/:roleId",
    requireValidOrganizationId,
    requireOrganizationPermissionFromParam(dependencies.authorizeOrganizationPermission, {
      organizationRoles: ["write"],
    }),
    async (context) => {
      const roleId = context.req.param("roleId");
      if (!z.uuid().safeParse(roleId).success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid organization role id");
      }
      try {
        await dependencies.organizationAccess.deleteRole(
          context.env,
          context.req.param("organizationId"),
          roleId,
        );
        return legacySuccess(context, { message: "organization role deleted" });
      } catch (error) {
        return organizationAccessFailure(context, error);
      }
    },
  );
  app.get(
    "/api/v1/organizations/:organizationId/members",
    requireValidOrganizationId,
    requireOrganizationPermissionFromParam(dependencies.authorizeOrganizationPermission, {
      organizationMembers: ["read"],
    }),
    async (context) => {
      try {
        const members = await dependencies.organizationAccess.listMembers(
          context.env,
          context.req.param("organizationId"),
        );
        return legacySuccess(context, members.map(organizationMemberResponse));
      } catch (error) {
        return organizationAccessFailure(context, error);
      }
    },
  );
  app.put(
    "/api/v1/organizations/:organizationId/members/:memberId/roles",
    requireValidOrganizationId,
    requireOrganizationPermissionFromParam(dependencies.authorizeOrganizationPermission, {
      organizationMembers: ["write"],
    }),
    async (context) => {
      const memberId = context.req.param("memberId")?.trim();
      const parsed = organizationMemberRolesBodySchema.safeParse(
        await context.req.json().catch(() => null),
      );
      if (!memberId || memberId.length > 255 || !parsed.success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid organization role assignment");
      }
      try {
        const member = await dependencies.organizationAccess.replaceMemberRoles(
          context.env,
          context.get("permissionGrants"),
          context.req.param("organizationId"),
          memberId,
          parsed.data.role_ids,
        );
        return legacySuccess(context, organizationMemberResponse(member));
      } catch (error) {
        return organizationAccessFailure(context, error);
      }
    },
  );
  app.get(
    "/api/v1/projects",
    requireOrganizationPermission(
      dependencies.authorizeOrganizationPermission,
      DEFAULT_ORGANIZATION_ID,
      {
        projects: ["read"],
      },
    ),
    async (context) => {
      const parsed = projectListQuerySchema.safeParse(context.req.query());
      if (!parsed.success) return legacyFailure(context, 400, "BAD_REQUEST", "Invalid pagination");
      const result = await dependencies.projects.list(
        context.env,
        DEFAULT_ORGANIZATION_ID,
        parsed.data.page,
        parsed.data.page_size,
      );
      return legacySuccess(context, {
        items: result.items.map(projectResponse),
        total: result.total,
        page: result.page,
        page_size: result.pageSize,
      });
    },
  );
  app.get(
    "/api/v1/projects/workspace-stats",
    requireOrganizationPermission(
      dependencies.authorizeOrganizationPermission,
      DEFAULT_ORGANIZATION_ID,
      {
        projects: ["read"],
      },
    ),
    async (context) => {
      const stats = await dependencies.projects.stats(context.env, DEFAULT_ORGANIZATION_ID);
      return legacySuccess(context, {
        open_task_count: stats.openTaskCount,
        team_member_count: stats.teamMemberCount,
        ai_agent_count: stats.aiAgentCount,
      });
    },
  );
  app.post(
    "/api/v1/projects",
    requireOrganizationPermission(
      dependencies.authorizeOrganizationPermission,
      DEFAULT_ORGANIZATION_ID,
      {
        projects: ["create"],
      },
    ),
    async (context) => {
      const body = await context.req.json().catch(() => null);
      const parsed = projectCreateBodySchema.safeParse(body);
      if (!parsed.success) return legacyFailure(context, 400, "BAD_REQUEST", "Invalid project");
      try {
        const project = await dependencies.projects.create(
          context.env,
          DEFAULT_ORGANIZATION_ID,
          context.get("permissionActorId"),
          {
            name: parsed.data.name,
            description: parsed.data.description,
            taskIdPrefix: parsed.data.task_id_prefix,
            isPublic: parsed.data.is_public,
            settings: parsed.data.settings,
          },
        );
        return context.json(
          {
            success: true as const,
            data: projectResponse(project),
            request_id: context.get("requestId"),
          },
          201,
        );
      } catch (error) {
        return projectFailure(context, error);
      }
    },
  );
  app.get(
    "/api/v1/projects/:projectId",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { projects: ["read"] }),
    async (context) => {
      try {
        return legacySuccess(
          context,
          projectResponse(
            await dependencies.projects.get(context.env, context.req.param("projectId")),
          ),
        );
      } catch (error) {
        return projectFailure(context, error);
      }
    },
  );
  app.patch(
    "/api/v1/projects/:projectId",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { projects: ["write"] }),
    async (context) => {
      const body = await context.req.json().catch(() => null);
      const parsed = projectUpdateBodySchema.safeParse(body);
      if (!parsed.success) return legacyFailure(context, 400, "BAD_REQUEST", "Invalid project");
      try {
        return legacySuccess(
          context,
          projectResponse(
            await dependencies.projects.update(context.env, context.req.param("projectId"), {
              name: parsed.data.name,
              description: parsed.data.description,
              taskIdPrefix: parsed.data.task_id_prefix,
              isPublic: parsed.data.is_public,
              settings: parsed.data.settings,
            }),
          ),
        );
      } catch (error) {
        return projectFailure(context, error);
      }
    },
  );
  app.delete(
    "/api/v1/projects/:projectId",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { projects: ["delete"] }),
    async (context) => {
      try {
        await dependencies.projects.archive(context.env, context.req.param("projectId"));
        return legacySuccess(context, { message: "project archived" });
      } catch (error) {
        return projectFailure(context, error);
      }
    },
  );
  app.get(
    "/api/v1/projects/:projectId/roles",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, {
      projectRoles: ["read"],
    }),
    async (context) => {
      try {
        const roles = await dependencies.projectAccess.listRoles(
          context.env,
          context.req.param("projectId"),
        );
        return legacySuccess(context, roles.map(projectRoleResponse));
      } catch (error) {
        return projectAccessFailure(context, error);
      }
    },
  );
  app.post(
    "/api/v1/projects/:projectId/roles",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, {
      projectRoles: ["write"],
    }),
    async (context) => {
      const parsed = projectRoleBodySchema.safeParse(await context.req.json().catch(() => null));
      if (!parsed.success) return legacyFailure(context, 400, "BAD_REQUEST", "Invalid role");
      try {
        const role = await dependencies.projectAccess.createRole(
          context.env,
          context.get("permissionGrants"),
          context.req.param("projectId"),
          {
            name: parsed.data.role_name,
            description: parsed.data.description,
            permissions: parsed.data.permissions,
          },
        );
        return context.json(
          {
            success: true as const,
            data: projectRoleResponse(role),
            request_id: context.get("requestId"),
          },
          201,
        );
      } catch (error) {
        return projectAccessFailure(context, error);
      }
    },
  );
  app.patch(
    "/api/v1/projects/:projectId/roles/:roleId",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, {
      projectRoles: ["write"],
    }),
    async (context) => {
      const roleId = context.req.param("roleId");
      const parsed = projectRoleBodySchema.safeParse(await context.req.json().catch(() => null));
      if (!z.uuid().safeParse(roleId).success || !parsed.success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid role");
      }
      try {
        const role = await dependencies.projectAccess.updateRole(
          context.env,
          context.get("permissionGrants"),
          context.req.param("projectId"),
          roleId,
          {
            name: parsed.data.role_name,
            description: parsed.data.description,
            permissions: parsed.data.permissions,
          },
        );
        return legacySuccess(context, projectRoleResponse(role));
      } catch (error) {
        return projectAccessFailure(context, error);
      }
    },
  );
  app.delete(
    "/api/v1/projects/:projectId/roles/:roleId",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, {
      projectRoles: ["write"],
    }),
    async (context) => {
      const roleId = context.req.param("roleId");
      if (!z.uuid().safeParse(roleId).success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid role id");
      }
      try {
        await dependencies.projectAccess.deleteRole(
          context.env,
          context.req.param("projectId"),
          roleId,
        );
        return legacySuccess(context, { message: "project role deleted" });
      } catch (error) {
        return projectAccessFailure(context, error);
      }
    },
  );
  app.get(
    "/api/v1/projects/:projectId/members",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, {
      projectMembers: ["read"],
    }),
    async (context) => {
      try {
        const members = await dependencies.projectAccess.listMembers(
          context.env,
          context.req.param("projectId"),
        );
        return legacySuccess(context, members.map(projectMemberResponse));
      } catch (error) {
        return projectAccessFailure(context, error);
      }
    },
  );
  app.get(
    "/api/v1/projects/:projectId/member-candidates",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, {
      projectMembers: ["write"],
    }),
    async (context) => {
      const parsed = userListQuerySchema.safeParse(context.req.query());
      if (!parsed.success) return legacyFailure(context, 400, "BAD_REQUEST", "Invalid pagination");
      const result = await dependencies.projectAccess.listUsers(
        context.env,
        parsed.data.page,
        parsed.data.page_size,
      );
      return legacySuccess(context, {
        items: result.items.map((item) => ({
          id: item.id,
          username: item.email.split("@")[0] || item.name,
          full_name: item.name,
          email: item.email,
          avatar_url: item.image,
          avatar_thumb_url: item.image,
          created_at: item.createdAt.toISOString(),
        })),
        total: result.total,
        page: result.page,
        page_size: result.pageSize,
      });
    },
  );
  app.post(
    "/api/v1/projects/:projectId/members",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, {
      projectMembers: ["write"],
    }),
    async (context) => {
      const parsed = projectMemberBodySchema.safeParse(await context.req.json().catch(() => null));
      if (!parsed.success) {
        return legacyFailure(
          context,
          400,
          "BAD_REQUEST",
          "Only Better Auth users can be added in this migration stage",
        );
      }
      try {
        const member = await dependencies.projectAccess.addMember(
          context.env,
          context.get("permissionGrants"),
          context.req.param("projectId"),
          parsed.data.user_id,
          parsed.data.project_role_id,
        );
        return context.json(
          {
            success: true as const,
            data: projectMemberResponse(member),
            request_id: context.get("requestId"),
          },
          201,
        );
      } catch (error) {
        return projectAccessFailure(context, error);
      }
    },
  );
  app.patch(
    "/api/v1/projects/:projectId/members/:memberId",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, {
      projectMembers: ["write"],
    }),
    async (context) => {
      const memberId = context.req.param("memberId");
      const parsed = projectMemberRoleBodySchema.safeParse(
        await context.req.json().catch(() => null),
      );
      if (!z.uuid().safeParse(memberId).success || !parsed.success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid member role");
      }
      try {
        const member = await dependencies.projectAccess.replaceMemberRole(
          context.env,
          context.get("permissionGrants"),
          context.req.param("projectId"),
          memberId,
          parsed.data.project_role_id,
        );
        return legacySuccess(context, projectMemberResponse(member));
      } catch (error) {
        return projectAccessFailure(context, error);
      }
    },
  );
  app.delete(
    "/api/v1/projects/:projectId/members/:memberId",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, {
      projectMembers: ["write"],
    }),
    async (context) => {
      const memberId = context.req.param("memberId");
      if (!z.uuid().safeParse(memberId).success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid member id");
      }
      try {
        await dependencies.projectAccess.removeMember(
          context.env,
          context.req.param("projectId"),
          memberId,
        );
        return legacySuccess(context, { message: "project member removed" });
      } catch (error) {
        return projectAccessFailure(context, error);
      }
    },
  );
  app.get(
    "/api/v1/projects/:projectId/task-types",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { tasks: ["read"] }),
    async (context) => {
      try {
        const taskTypes = await dependencies.tasks.listTypes(
          context.env,
          context.req.param("projectId"),
        );
        return legacySuccess(context, { items: taskTypes.map(taskTypeResponse) });
      } catch (error) {
        return taskFailure(context, error);
      }
    },
  );
  app.get(
    "/api/v1/projects/:projectId/task-statuses",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { tasks: ["read"] }),
    async (context) => {
      try {
        const statuses = await dependencies.tasks.listStatuses(
          context.env,
          context.req.param("projectId"),
        );
        return legacySuccess(context, { items: statuses.map(taskStatusResponse) });
      } catch (error) {
        return taskFailure(context, error);
      }
    },
  );
  app.get(
    "/api/v1/projects/:projectId/custom-fields",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { tasks: ["read"] }),
    async (context) => {
      try {
        const fields = await dependencies.customFields.list(
          context.env,
          context.req.param("projectId"),
        );
        return legacySuccess(context, { items: fields.map(customFieldResponse) });
      } catch (error) {
        return customFieldFailure(context, error);
      }
    },
  );
  app.post(
    "/api/v1/projects/:projectId/custom-fields",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { tasks: ["write"] }),
    async (context) => {
      const parsed = customFieldCreateBodySchema.safeParse(
        await context.req.json().catch(() => null),
      );
      if (!parsed.success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid custom field");
      }
      try {
        const field = await dependencies.customFields.create(
          context.env,
          context.req.param("projectId"),
          {
            fieldKey: parsed.data.field_key,
            displayName: parsed.data.display_name,
            fieldType: parsed.data.field_type,
            options: parsed.data.options,
            isRequired: parsed.data.is_required,
          },
        );
        return context.json(
          {
            success: true as const,
            data: customFieldResponse(field),
            request_id: context.get("requestId"),
          },
          201,
        );
      } catch (error) {
        return customFieldFailure(context, error);
      }
    },
  );
  app.get(
    "/api/v1/projects/:projectId/custom-fields/:fieldId",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { tasks: ["read"] }),
    async (context) => {
      const fieldId = context.req.param("fieldId");
      if (!z.uuid().safeParse(fieldId).success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid custom field id");
      }
      try {
        const field = await dependencies.customFields.get(
          context.env,
          context.req.param("projectId"),
          fieldId,
        );
        return legacySuccess(context, customFieldResponse(field));
      } catch (error) {
        return customFieldFailure(context, error);
      }
    },
  );
  app.patch(
    "/api/v1/projects/:projectId/custom-fields/:fieldId",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { tasks: ["write"] }),
    async (context) => {
      const fieldId = context.req.param("fieldId");
      const parsed = customFieldUpdateBodySchema.safeParse(
        await context.req.json().catch(() => null),
      );
      if (!z.uuid().safeParse(fieldId).success || !parsed.success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid custom field update");
      }
      try {
        const field = await dependencies.customFields.update(
          context.env,
          context.req.param("projectId"),
          fieldId,
          {
            displayName: parsed.data.display_name,
            options: parsed.data.options,
            isRequired: parsed.data.is_required,
          },
        );
        return legacySuccess(context, customFieldResponse(field));
      } catch (error) {
        return customFieldFailure(context, error);
      }
    },
  );
  app.delete(
    "/api/v1/projects/:projectId/custom-fields/:fieldId",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { tasks: ["write"] }),
    async (context) => {
      const fieldId = context.req.param("fieldId");
      if (!z.uuid().safeParse(fieldId).success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid custom field id");
      }
      try {
        await dependencies.customFields.delete(
          context.env,
          context.req.param("projectId"),
          fieldId,
        );
        return legacySuccess(context, { message: "custom field deleted" });
      } catch (error) {
        return customFieldFailure(context, error);
      }
    },
  );
  app.get(
    "/api/v1/projects/:projectId/sprints",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { sprints: ["read"] }),
    async (context) => {
      try {
        const sprints = await dependencies.iterations.listSprints(
          context.env,
          context.req.param("projectId"),
        );
        return legacySuccess(context, { items: sprints.map(sprintResponse) });
      } catch (error) {
        return iterationFailure(context, error);
      }
    },
  );
  app.post(
    "/api/v1/projects/:projectId/sprints",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { sprints: ["write"] }),
    async (context) => {
      const parsed = sprintCreateBodySchema.safeParse(await context.req.json().catch(() => null));
      if (!parsed.success) return legacyFailure(context, 400, "BAD_REQUEST", "Invalid sprint");
      try {
        const sprint = await dependencies.iterations.createSprint(
          context.env,
          context.req.param("projectId"),
          {
            name: parsed.data.name,
            startDate: parsed.data.start_date,
            endDate: parsed.data.end_date,
            goal: parsed.data.goal,
            status: parsed.data.status,
          },
        );
        return context.json(
          {
            success: true as const,
            data: sprintResponse(sprint),
            request_id: context.get("requestId"),
          },
          201,
        );
      } catch (error) {
        return iterationFailure(context, error);
      }
    },
  );
  app.get(
    "/api/v1/projects/:projectId/sprints/:sprintId",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { sprints: ["read"] }),
    async (context) => {
      const sprintId = context.req.param("sprintId");
      if (!z.uuid().safeParse(sprintId).success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid sprint id");
      }
      try {
        const sprint = await dependencies.iterations.getSprint(
          context.env,
          context.req.param("projectId"),
          sprintId,
        );
        return legacySuccess(context, sprintResponse(sprint));
      } catch (error) {
        return iterationFailure(context, error);
      }
    },
  );
  app.patch(
    "/api/v1/projects/:projectId/sprints/:sprintId",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { sprints: ["write"] }),
    async (context) => {
      const sprintId = context.req.param("sprintId");
      const parsed = sprintUpdateBodySchema.safeParse(await context.req.json().catch(() => null));
      if (!z.uuid().safeParse(sprintId).success || !parsed.success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid sprint update");
      }
      try {
        const sprint = await dependencies.iterations.updateSprint(
          context.env,
          context.req.param("projectId"),
          sprintId,
          {
            name: parsed.data.name,
            startDate: parsed.data.start_date,
            endDate: parsed.data.end_date,
            goal: parsed.data.goal,
            status: parsed.data.status,
          },
        );
        return legacySuccess(context, sprintResponse(sprint));
      } catch (error) {
        return iterationFailure(context, error);
      }
    },
  );
  app.delete(
    "/api/v1/projects/:projectId/sprints/:sprintId",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { sprints: ["write"] }),
    async (context) => {
      const sprintId = context.req.param("sprintId");
      if (!z.uuid().safeParse(sprintId).success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid sprint id");
      }
      try {
        await dependencies.iterations.deleteSprint(
          context.env,
          context.req.param("projectId"),
          sprintId,
          context.get("permissionActorId"),
        );
        return legacySuccess(context, { message: "sprint deleted" });
      } catch (error) {
        return iterationFailure(context, error);
      }
    },
  );
  app.post(
    "/api/v1/projects/:projectId/sprints/:sprintId/complete",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { sprints: ["write"] }),
    async (context) => {
      const sprintId = context.req.param("sprintId");
      const parsed = sprintCompleteBodySchema.safeParse(await context.req.json().catch(() => ({})));
      if (!z.uuid().safeParse(sprintId).success || !parsed.success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid sprint completion");
      }
      try {
        const sprint = await dependencies.iterations.completeSprint(
          context.env,
          context.req.param("projectId"),
          sprintId,
          parsed.data.move_to_sprint_id ?? null,
          context.get("permissionActorId"),
        );
        return legacySuccess(context, sprintResponse(sprint));
      } catch (error) {
        return iterationFailure(context, error);
      }
    },
  );
  app.get(
    "/api/v1/projects/:projectId/views",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { sprints: ["read"] }),
    async (context) => {
      const parsed = viewQuerySchema.safeParse(context.req.query());
      if (
        !parsed.success ||
        (parsed.data.context === "sprint") !== Boolean(parsed.data.sprint_id)
      ) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid view context");
      }
      try {
        const views = await dependencies.iterations.listViews(
          context.env,
          context.req.param("projectId"),
          parsed.data.context,
          parsed.data.sprint_id ?? null,
        );
        return legacySuccess(context, { items: views.map(viewResponse) });
      } catch (error) {
        return iterationFailure(context, error);
      }
    },
  );
  app.post(
    "/api/v1/projects/:projectId/views",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { sprints: ["write"] }),
    async (context) => {
      const query = viewQuerySchema.safeParse(context.req.query());
      const body = viewCreateBodySchema.safeParse(await context.req.json().catch(() => null));
      if (
        !query.success ||
        !body.success ||
        (query.data.context === "sprint") !== Boolean(query.data.sprint_id)
      ) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid view");
      }
      try {
        const view = await dependencies.iterations.createView(
          context.env,
          context.req.param("projectId"),
          query.data.context,
          query.data.sprint_id ?? null,
          {
            name: body.data.name,
            viewType: body.data.view_type,
            config: body.data.config,
            position: body.data.position,
          },
        );
        return context.json(
          {
            success: true as const,
            data: viewResponse(view),
            request_id: context.get("requestId"),
          },
          201,
        );
      } catch (error) {
        return iterationFailure(context, error);
      }
    },
  );
  app.put(
    "/api/v1/projects/:projectId/views/positions",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { sprints: ["write"] }),
    async (context) => {
      const query = viewQuerySchema.safeParse(context.req.query());
      const body = viewReorderBodySchema.safeParse(await context.req.json().catch(() => null));
      if (
        !query.success ||
        !body.success ||
        (query.data.context === "sprint") !== Boolean(query.data.sprint_id)
      ) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid view reorder");
      }
      try {
        await dependencies.iterations.reorderViews(
          context.env,
          context.req.param("projectId"),
          query.data.context,
          query.data.sprint_id ?? null,
          body.data.view_ids,
        );
        return legacySuccess(context, { message: "views reordered" });
      } catch (error) {
        return iterationFailure(context, error);
      }
    },
  );
  app.get(
    "/api/v1/projects/:projectId/views/:viewId",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { sprints: ["read"] }),
    async (context) => {
      const viewId = context.req.param("viewId");
      if (!z.uuid().safeParse(viewId).success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid view id");
      }
      try {
        const view = await dependencies.iterations.getView(
          context.env,
          context.req.param("projectId"),
          viewId,
        );
        return legacySuccess(context, viewResponse(view));
      } catch (error) {
        return iterationFailure(context, error);
      }
    },
  );
  app.patch(
    "/api/v1/projects/:projectId/views/:viewId",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { sprints: ["write"] }),
    async (context) => {
      const viewId = context.req.param("viewId");
      const parsed = viewUpdateBodySchema.safeParse(await context.req.json().catch(() => null));
      if (!z.uuid().safeParse(viewId).success || !parsed.success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid view update");
      }
      try {
        const view = await dependencies.iterations.updateView(
          context.env,
          context.req.param("projectId"),
          viewId,
          {
            name: parsed.data.name,
            viewType: parsed.data.view_type,
            config: parsed.data.config,
            position: parsed.data.position,
          },
        );
        return legacySuccess(context, viewResponse(view));
      } catch (error) {
        return iterationFailure(context, error);
      }
    },
  );
  app.delete(
    "/api/v1/projects/:projectId/views/:viewId",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { sprints: ["write"] }),
    async (context) => {
      const viewId = context.req.param("viewId");
      if (!z.uuid().safeParse(viewId).success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid view id");
      }
      try {
        await dependencies.iterations.deleteView(
          context.env,
          context.req.param("projectId"),
          viewId,
        );
        return context.body(null, 204);
      } catch (error) {
        return iterationFailure(context, error);
      }
    },
  );
  app.get(
    "/api/v1/projects/:projectId/views/:viewId/task-positions",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { sprints: ["read"] }),
    async (context) => {
      const viewId = context.req.param("viewId");
      if (!z.uuid().safeParse(viewId).success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid view id");
      }
      try {
        const positions = await dependencies.iterations.listTaskPositions(
          context.env,
          context.req.param("projectId"),
          viewId,
        );
        return legacySuccess(context, { items: positions.map(taskPositionResponse) });
      } catch (error) {
        return iterationFailure(context, error);
      }
    },
  );
  app.put(
    "/api/v1/projects/:projectId/views/:viewId/task-positions",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { sprints: ["write"] }),
    async (context) => {
      const viewId = context.req.param("viewId");
      const parsed = taskPositionsBodySchema.safeParse(await context.req.json().catch(() => null));
      if (!z.uuid().safeParse(viewId).success || !parsed.success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid task positions");
      }
      try {
        await dependencies.iterations.upsertTaskPositions(
          context.env,
          context.req.param("projectId"),
          viewId,
          parsed.data.items.map((item) => ({
            taskId: item.task_id,
            position: item.position,
            groupKey: item.group_key,
          })),
        );
        return context.body(null, 204);
      } catch (error) {
        return iterationFailure(context, error);
      }
    },
  );
  app.put(
    "/api/v1/projects/:projectId/views/:viewId/task-positions/:taskId",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { sprints: ["write"] }),
    async (context) => {
      const viewId = context.req.param("viewId");
      const taskId = context.req.param("taskId");
      const parsed = taskPositionBodySchema.safeParse(await context.req.json().catch(() => null));
      if (
        !z.uuid().safeParse(viewId).success ||
        !z.uuid().safeParse(taskId).success ||
        !parsed.success
      ) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid task position");
      }
      try {
        await dependencies.iterations.upsertTaskPositions(
          context.env,
          context.req.param("projectId"),
          viewId,
          [{ taskId, position: parsed.data.position, groupKey: parsed.data.group_key }],
        );
        return context.body(null, 204);
      } catch (error) {
        return iterationFailure(context, error);
      }
    },
  );
  app.get(
    "/api/v1/projects/:projectId/docs",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { docs: ["read"] }),
    async (context) => {
      try {
        const documents = await dependencies.documents.list(
          context.env,
          context.req.param("projectId"),
        );
        return legacySuccess(context, { items: documents.map(documentResponse) });
      } catch (error) {
        return documentFailure(context, error);
      }
    },
  );
  app.post(
    "/api/v1/projects/:projectId/docs",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { docs: ["write"] }),
    async (context) => {
      const parsed = documentCreateBodySchema.safeParse(await context.req.json().catch(() => null));
      if (!parsed.success) return legacyFailure(context, 400, "BAD_REQUEST", "Invalid document");
      try {
        const document = await dependencies.documents.create(
          context.env,
          context.req.param("projectId"),
          context.get("permissionActorId"),
          parsed.data,
        );
        return context.json(
          {
            success: true as const,
            data: documentResponse(document),
            request_id: context.get("requestId"),
          },
          201,
        );
      } catch (error) {
        return documentFailure(context, error);
      }
    },
  );
  app.get(
    "/api/v1/projects/:projectId/docs/:docId",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { docs: ["read"] }),
    async (context) => {
      const documentId = context.req.param("docId");
      if (!z.uuid().safeParse(documentId).success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid document id");
      }
      try {
        const document = await dependencies.documents.get(
          context.env,
          context.req.param("projectId"),
          documentId,
        );
        return legacySuccess(context, documentResponse(document));
      } catch (error) {
        return documentFailure(context, error);
      }
    },
  );
  app.patch(
    "/api/v1/projects/:projectId/docs/:docId",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { docs: ["write"] }),
    async (context) => {
      const documentId = context.req.param("docId");
      const parsed = documentUpdateBodySchema.safeParse(await context.req.json().catch(() => null));
      if (!z.uuid().safeParse(documentId).success || !parsed.success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid document update");
      }
      try {
        const document = await dependencies.documents.update(
          context.env,
          context.req.param("projectId"),
          documentId,
          context.get("permissionActorId"),
          parsed.data,
        );
        return legacySuccess(context, documentResponse(document));
      } catch (error) {
        return documentFailure(context, error);
      }
    },
  );
  app.delete(
    "/api/v1/projects/:projectId/docs/:docId",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { docs: ["write"] }),
    async (context) => {
      const documentId = context.req.param("docId");
      if (!z.uuid().safeParse(documentId).success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid document id");
      }
      try {
        await dependencies.documents.archive(
          context.env,
          context.req.param("projectId"),
          documentId,
          context.get("permissionActorId"),
        );
        return context.body(null, 204);
      } catch (error) {
        return documentFailure(context, error);
      }
    },
  );
  app.get(
    "/api/v1/projects/:projectId/docs/:docId/collaboration",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { docs: ["read"] }),
    async (context) => {
      const documentId = context.req.param("docId");
      if (!z.uuid().safeParse(documentId).success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid document id");
      }
      try {
        await dependencies.documents.get(context.env, context.req.param("projectId"), documentId);
        const status = await dependencies.documents.collaborationStatus(context.env, documentId);
        return legacySuccess(context, {
          initialized: status.initialized,
          update_count: status.updateCount,
          update_bytes: status.updateBytes,
          checkpoint_bytes: status.checkpointBytes,
        });
      } catch (error) {
        return documentFailure(context, error);
      }
    },
  );
  app.post(
    "/api/v1/projects/:projectId/docs/:docId/collaboration/bootstrap",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { docs: ["write"] }),
    async (context) => {
      const documentId = context.req.param("docId");
      const parsed = documentBootstrapBodySchema.safeParse(
        await context.req.json().catch(() => null),
      );
      const update = parsed.success
        ? decodeDocumentBootstrapUpdate(parsed.data.update_base64)
        : null;
      if (!z.uuid().safeParse(documentId).success || !update) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid collaboration bootstrap");
      }
      try {
        await dependencies.documents.get(context.env, context.req.param("projectId"), documentId);
        const result = await dependencies.documents.bootstrapCollaboration(
          context.env,
          documentId,
          update,
        );
        return legacySuccess(context, result);
      } catch (error) {
        return documentFailure(context, error);
      }
    },
  );
  app.get(
    "/api/v1/projects/:projectId/tasks",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { tasks: ["read"] }),
    async (context) => {
      const parsed = taskListQuerySchema.safeParse(context.req.query());
      if (!parsed.success) return legacyFailure(context, 400, "BAD_REQUEST", "Invalid task query");
      const statusIds = commaSeparatedUuids(parsed.data.status_ids);
      const taskTypeIds = commaSeparatedUuids(parsed.data.task_type_ids);
      const sprintIds = commaSeparatedUuids(parsed.data.sprint_ids);
      const assigneeIds = commaSeparatedUuids(parsed.data.assignee_ids);
      if (
        statusIds === null ||
        taskTypeIds === null ||
        sprintIds === null ||
        assigneeIds === null
      ) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid task filters");
      }
      let sprintId =
        parsed.data.sprint_id === undefined
          ? undefined
          : parsed.data.sprint_id === "null"
            ? null
            : parsed.data.sprint_id;
      if (typeof sprintId === "string" && !z.uuid().safeParse(sprintId).success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid sprint filter");
      }
      if (sprintIds.length > 0) sprintId = undefined;
      if (parsed.data.status_id) statusIds.push(parsed.data.status_id);
      let assigneeNull = false;
      if (parsed.data.assignee_id === "null") assigneeNull = true;
      else if (parsed.data.assignee_id) {
        if (!z.uuid().safeParse(parsed.data.assignee_id).success) {
          return legacyFailure(context, 400, "BAD_REQUEST", "Invalid assignee filter");
        }
        assigneeIds.push(parsed.data.assignee_id);
      }
      let taskTypeNull = false;
      if (parsed.data.task_type_id === "null") taskTypeNull = true;
      else if (parsed.data.task_type_id) {
        if (!z.uuid().safeParse(parsed.data.task_type_id).success) {
          return legacyFailure(context, 400, "BAD_REQUEST", "Invalid task type filter");
        }
        taskTypeIds.splice(0, taskTypeIds.length, parsed.data.task_type_id);
      }
      let customFieldFilters = {};
      if (parsed.data.custom_field_filters) {
        const decoded = (() => {
          try {
            return JSON.parse(parsed.data.custom_field_filters as string) as unknown;
          } catch {
            return null;
          }
        })();
        const customFields = customFieldFiltersSchema.safeParse(decoded);
        if (!customFields.success) {
          return legacyFailure(context, 400, "BAD_REQUEST", "Invalid custom field filters");
        }
        customFieldFilters = customFields.data;
      }
      let importanceRanges: { min: number; max: number }[] = [];
      if (parsed.data.importance_ranges) {
        const decoded = (() => {
          try {
            return JSON.parse(parsed.data.importance_ranges as string) as unknown;
          } catch {
            return null;
          }
        })();
        const ranges = importanceRangesSchema.safeParse(decoded);
        if (!ranges.success || ranges.data.some(({ min, max }) => min > max)) {
          return legacyFailure(context, 400, "BAD_REQUEST", "Invalid importance ranges");
        }
        importanceRanges = ranges.data;
      }
      const tags = parsed.data.tags
        ? [
            ...new Set(
              parsed.data.tags
                .split(",")
                .map((tag) => tag.trim())
                .filter(Boolean),
            ),
          ]
        : [];
      try {
        const result = await dependencies.tasks.list(context.env, context.req.param("projectId"), {
          pageSize: parsed.data.page_size,
          cursor: parsed.data.cursor,
          search: parsed.data.search,
          statusIds,
          sprintIds,
          assigneeIds,
          assigneeNull,
          taskTypeIds,
          taskTypeNull,
          parentTaskId: parsed.data.parent_task_id,
          sprintId,
          sortBy: parsed.data.sort_by,
          viewId: parsed.data.view_id,
          sumField: parsed.data.sum_field,
          customFieldFilters,
          startDateAfter: parsed.data.start_date_after,
          startDateBefore: parsed.data.start_date_before,
          dueDateAfter: parsed.data.due_date_after,
          dueDateBefore: parsed.data.due_date_before,
          storyPointsMin: parsed.data.story_points_min,
          storyPointsMax: parsed.data.story_points_max,
          importanceRanges,
          tags,
        });
        return legacySuccess(context, {
          items: result.items.map(taskResponse),
          page_size: result.pageSize,
          next_cursor: result.nextCursor,
          total_count: result.totalCount,
          field_sum: result.fieldSum,
        });
      } catch (error) {
        return taskFailure(context, error);
      }
    },
  );
  app.post(
    "/api/v1/projects/:projectId/tasks",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { tasks: ["write"] }),
    async (context) => {
      const parsed = taskCreateBodySchema.safeParse(await context.req.json().catch(() => null));
      if (!parsed.success) return legacyFailure(context, 400, "BAD_REQUEST", "Invalid task");
      try {
        const task = await dependencies.tasks.create(
          context.env,
          context.req.param("projectId"),
          context.get("permissionActorId"),
          {
            title: parsed.data.title,
            statusId: parsed.data.status_id,
            sprintId: parsed.data.sprint_id,
            taskTypeId: parsed.data.task_type_id,
            parentTaskId: parsed.data.parent_task_id,
            description: parsed.data.description,
            importance: parsed.data.importance,
            storyPoints: parsed.data.story_points,
            assigneeIds: parsed.data.assignee_ids,
            customFields: parsed.data.custom_fields,
            startDate: parsed.data.start_date,
            dueDate: parsed.data.due_date,
            tags: parsed.data.tags,
          },
        );
        return context.json(
          {
            success: true as const,
            data: taskResponse(task),
            request_id: context.get("requestId"),
          },
          201,
        );
      } catch (error) {
        return taskFailure(context, error);
      }
    },
  );
  app.get(
    "/api/v1/projects/:projectId/tasks/:taskId",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { tasks: ["read"] }),
    async (context) => {
      const taskId = context.req.param("taskId");
      if (!z.uuid().safeParse(taskId).success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid task id");
      }
      try {
        return legacySuccess(
          context,
          taskResponse(
            await dependencies.tasks.get(context.env, context.req.param("projectId"), taskId),
          ),
        );
      } catch (error) {
        return taskFailure(context, error);
      }
    },
  );
  app.patch(
    "/api/v1/projects/:projectId/tasks/:taskId",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { tasks: ["write"] }),
    async (context) => {
      const taskId = context.req.param("taskId");
      const parsed = taskUpdateBodySchema.safeParse(await context.req.json().catch(() => null));
      if (!z.uuid().safeParse(taskId).success || !parsed.success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid task update");
      }
      try {
        const task = await dependencies.tasks.update(
          context.env,
          context.req.param("projectId"),
          taskId,
          context.get("permissionActorId"),
          {
            title: parsed.data.title,
            statusId: parsed.data.status_id,
            sprintId: parsed.data.sprint_id,
            taskTypeId: parsed.data.task_type_id,
            parentTaskId: parsed.data.parent_task_id,
            description: parsed.data.description,
            importance: parsed.data.importance,
            storyPoints: parsed.data.story_points,
            assigneeIds: parsed.data.assignee_ids,
            customFields: parsed.data.custom_fields,
            startDate: parsed.data.start_date,
            dueDate: parsed.data.due_date,
            tags: parsed.data.tags,
          },
        );
        return legacySuccess(context, taskResponse(task));
      } catch (error) {
        return taskFailure(context, error);
      }
    },
  );
  app.delete(
    "/api/v1/projects/:projectId/tasks/:taskId",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { tasks: ["write"] }),
    async (context) => {
      const taskId = context.req.param("taskId");
      if (!z.uuid().safeParse(taskId).success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid task id");
      }
      try {
        await dependencies.tasks.archive(
          context.env,
          context.req.param("projectId"),
          taskId,
          context.get("permissionActorId"),
        );
        return legacySuccess(context, { message: "task archived" });
      } catch (error) {
        return taskFailure(context, error);
      }
    },
  );
  app.get(
    "/api/v1/projects/:projectId/tasks/:taskId/links",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { tasks: ["read"] }),
    async (context) => {
      const taskId = context.req.param("taskId");
      if (!z.uuid().safeParse(taskId).success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid task id");
      }
      try {
        const links = await dependencies.taskLinks.list(
          context.env,
          context.req.param("projectId"),
          taskId,
        );
        return legacySuccess(context, { items: links.map(taskLinkResponse) });
      } catch (error) {
        return taskLinkFailure(context, error);
      }
    },
  );
  app.post(
    "/api/v1/projects/:projectId/tasks/:taskId/links",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { tasks: ["write"] }),
    async (context) => {
      const taskId = context.req.param("taskId");
      const parsed = taskLinkBodySchema.safeParse(await context.req.json().catch(() => null));
      if (!z.uuid().safeParse(taskId).success || !parsed.success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid task link");
      }
      try {
        const link = await dependencies.taskLinks.create(
          context.env,
          context.req.param("projectId"),
          taskId,
          context.get("permissionActorId"),
          {
            targetTaskId: parsed.data.target_task_id,
            linkType: parsed.data.link_type,
          },
        );
        return context.json(
          {
            success: true as const,
            data: taskLinkResponse(link),
            request_id: context.get("requestId"),
          },
          201,
        );
      } catch (error) {
        return taskLinkFailure(context, error);
      }
    },
  );
  app.delete(
    "/api/v1/projects/:projectId/tasks/:taskId/links/:linkId",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { tasks: ["write"] }),
    async (context) => {
      const taskId = context.req.param("taskId");
      const linkId = context.req.param("linkId");
      if (!z.uuid().safeParse(taskId).success || !z.uuid().safeParse(linkId).success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid task link id");
      }
      try {
        await dependencies.taskLinks.delete(
          context.env,
          context.req.param("projectId"),
          taskId,
          linkId,
          context.get("permissionActorId"),
        );
        return new Response(null, { status: 204 });
      } catch (error) {
        return taskLinkFailure(context, error);
      }
    },
  );
  app.get(
    "/api/v1/projects/:projectId/tasks/:taskId/attachments",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { tasks: ["read"] }),
    async (context) => {
      const taskId = context.req.param("taskId");
      if (!z.uuid().safeParse(taskId).success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid task id");
      }
      try {
        const attachments = await dependencies.attachments.list(
          context.env,
          context.req.param("projectId"),
          taskId,
          context.req.query("deleted") === "true",
        );
        return legacySuccess(context, { items: attachments.map(attachmentResponse) });
      } catch (error) {
        return attachmentFailure(context, error);
      }
    },
  );
  app.post(
    "/api/v1/projects/:projectId/tasks/:taskId/attachments/initiate-upload",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { tasks: ["write"] }),
    async (context) => {
      const projectId = context.req.param("projectId");
      const taskId = context.req.param("taskId");
      const parsed = attachmentInitiateBodySchema.safeParse(
        await context.req.json().catch(() => null),
      );
      if (!z.uuid().safeParse(taskId).success || !parsed.success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid attachment upload");
      }
      try {
        const session = await dependencies.attachments.initiate(
          context.env,
          projectId,
          taskId,
          context.get("permissionActorId"),
          {
            fileName: parsed.data.file_name,
            contentType: parsed.data.content_type,
            fileSize: parsed.data.file_size,
          },
          `/api/v1/projects/${projectId}/tasks/${taskId}/attachments/uploads`,
        );
        return context.json(
          {
            success: true as const,
            data: attachmentUploadSessionResponse(session),
            request_id: context.get("requestId"),
          },
          201,
        );
      } catch (error) {
        return attachmentFailure(context, error);
      }
    },
  );
  app.put(
    "/api/v1/projects/:projectId/tasks/:taskId/attachments/uploads/:fileId",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { tasks: ["write"] }),
    async (context) => {
      const taskId = context.req.param("taskId");
      const fileId = context.req.param("fileId");
      if (!z.uuid().safeParse(taskId).success || !z.uuid().safeParse(fileId).success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid attachment upload");
      }
      try {
        const result = await dependencies.attachments.upload(
          context.env,
          context.req.param("projectId"),
          taskId,
          fileId,
          context.get("permissionActorId"),
          contentLength(context.req.raw),
          context.req.raw.body,
        );
        context.header("etag", result.etag);
        return context.body(null, 204);
      } catch (error) {
        return attachmentFailure(context, error);
      }
    },
  );
  app.put(
    "/api/v1/projects/:projectId/tasks/:taskId/attachments/uploads/:fileId/parts/:partNumber",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { tasks: ["write"] }),
    async (context) => {
      const taskId = context.req.param("taskId");
      const fileId = context.req.param("fileId");
      const partNumber = Number(context.req.param("partNumber"));
      if (
        !z.uuid().safeParse(taskId).success ||
        !z.uuid().safeParse(fileId).success ||
        !Number.isSafeInteger(partNumber)
      ) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid attachment part");
      }
      try {
        const result = await dependencies.attachments.uploadPart(
          context.env,
          context.req.param("projectId"),
          taskId,
          fileId,
          partNumber,
          context.get("permissionActorId"),
          contentLength(context.req.raw),
          context.req.raw.body,
        );
        context.header("etag", result.etag);
        return context.body(null, 204);
      } catch (error) {
        return attachmentFailure(context, error);
      }
    },
  );
  app.post(
    "/api/v1/projects/:projectId/tasks/:taskId/attachments/complete-upload",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { tasks: ["write"] }),
    async (context) => {
      const taskId = context.req.param("taskId");
      const parsed = attachmentCompleteBodySchema.safeParse(
        await context.req.json().catch(() => null),
      );
      if (!z.uuid().safeParse(taskId).success || !parsed.success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid attachment completion");
      }
      try {
        const attachment = await dependencies.attachments.complete(
          context.env,
          context.req.param("projectId"),
          taskId,
          parsed.data.file_id,
          context.get("permissionActorId"),
          parsed.data.upload_id ?? null,
          (parsed.data.parts ?? []).map((part) => ({
            partNumber: part.part_number,
            etag: part.etag,
          })),
        );
        return context.json(
          {
            success: true as const,
            data: attachmentResponse(attachment),
            request_id: context.get("requestId"),
          },
          201,
        );
      } catch (error) {
        return attachmentFailure(context, error);
      }
    },
  );
  app.delete(
    "/api/v1/projects/:projectId/tasks/:taskId/attachments/uploads/:fileId",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { tasks: ["write"] }),
    async (context) => {
      const taskId = context.req.param("taskId");
      const fileId = context.req.param("fileId");
      if (!z.uuid().safeParse(taskId).success || !z.uuid().safeParse(fileId).success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid attachment upload");
      }
      try {
        await dependencies.attachments.cancel(
          context.env,
          context.req.param("projectId"),
          taskId,
          fileId,
          context.get("permissionActorId"),
        );
        return context.body(null, 204);
      } catch (error) {
        return attachmentFailure(context, error);
      }
    },
  );
  app.post(
    "/api/v1/projects/:projectId/tasks/:taskId/attachments/:attachmentId/restore",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { tasks: ["write"] }),
    async (context) => {
      const taskId = context.req.param("taskId");
      const attachmentId = context.req.param("attachmentId");
      if (!z.uuid().safeParse(taskId).success || !z.uuid().safeParse(attachmentId).success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid attachment id");
      }
      try {
        return legacySuccess(
          context,
          attachmentResponse(
            await dependencies.attachments.restore(
              context.env,
              context.req.param("projectId"),
              taskId,
              attachmentId,
              context.get("permissionActorId"),
            ),
          ),
        );
      } catch (error) {
        return attachmentFailure(context, error);
      }
    },
  );
  app.get(
    "/api/v1/projects/:projectId/tasks/:taskId/attachments/:attachmentId/download-url",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { tasks: ["read"] }),
    async (context) => {
      const projectId = context.req.param("projectId");
      const taskId = context.req.param("taskId");
      const attachmentId = context.req.param("attachmentId");
      if (!z.uuid().safeParse(taskId).success || !z.uuid().safeParse(attachmentId).success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid attachment id");
      }
      try {
        await dependencies.attachments.get(context.env, projectId, taskId, attachmentId);
        const download = context.req.query("download") === "true" ? "?download=true" : "";
        return legacySuccess(context, {
          url: `/api/v1/projects/${projectId}/tasks/${taskId}/attachments/${attachmentId}/content${download}`,
        });
      } catch (error) {
        return attachmentFailure(context, error);
      }
    },
  );
  app.get(
    "/api/v1/projects/:projectId/tasks/:taskId/attachments/:attachmentId/content",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { tasks: ["read"] }),
    async (context) => {
      const taskId = context.req.param("taskId");
      const attachmentId = context.req.param("attachmentId");
      if (!z.uuid().safeParse(taskId).success || !z.uuid().safeParse(attachmentId).success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid attachment id");
      }
      try {
        const { attachment, object } = await dependencies.attachments.content(
          context.env,
          context.req.param("projectId"),
          taskId,
          attachmentId,
          context.req.header("range"),
        );
        const forceDownload = context.req.query("download") === "true";
        const mode =
          forceDownload || !canPreviewAttachment(attachment.file.contentType)
            ? "attachment"
            : "inline";
        const headers = new Headers({
          "accept-ranges": "bytes",
          "cache-control": "private, no-store",
          "content-disposition": attachmentDisposition(attachment.file.fileName, mode),
          "content-type": attachment.file.contentType,
          etag: object.etag,
          "x-content-type-options": "nosniff",
          "x-request-id": context.get("requestId"),
        });
        let status = 200;
        if (object.range) {
          status = 206;
          headers.set("content-length", String(object.range.length));
          headers.set(
            "content-range",
            `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${object.size}`,
          );
        } else {
          headers.set("content-length", String(object.size));
        }
        return new Response(object.body, { status, headers });
      } catch (error) {
        return attachmentFailure(context, error);
      }
    },
  );
  app.delete(
    "/api/v1/projects/:projectId/tasks/:taskId/attachments/:attachmentId",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { tasks: ["write"] }),
    async (context) => {
      const taskId = context.req.param("taskId");
      const attachmentId = context.req.param("attachmentId");
      if (!z.uuid().safeParse(taskId).success || !z.uuid().safeParse(attachmentId).success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid attachment id");
      }
      try {
        await dependencies.attachments.delete(
          context.env,
          context.req.param("projectId"),
          taskId,
          attachmentId,
          context.get("permissionActorId"),
        );
        return context.body(null, 204);
      } catch (error) {
        return attachmentFailure(context, error);
      }
    },
  );
  app.get(
    "/api/v1/projects/:projectId/tasks/:taskId/activities",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { tasks: ["read"] }),
    async (context) => {
      const taskId = context.req.param("taskId");
      if (!z.uuid().safeParse(taskId).success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid task id");
      }
      try {
        const activities = await dependencies.taskActivities.list(
          context.env,
          context.req.param("projectId"),
          taskId,
        );
        return legacySuccess(context, { items: activities.map(taskActivityResponse) });
      } catch (error) {
        return taskActivityFailure(context, error);
      }
    },
  );
  app.post(
    "/api/v1/projects/:projectId/tasks/:taskId/activities/comments",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { tasks: ["write"] }),
    async (context) => {
      const taskId = context.req.param("taskId");
      const parsed = taskCommentBodySchema.safeParse(await context.req.json().catch(() => null));
      if (!z.uuid().safeParse(taskId).success || !parsed.success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid task comment");
      }
      try {
        const activity = await dependencies.taskActivities.createComment(
          context.env,
          context.req.param("projectId"),
          taskId,
          context.get("permissionActorId"),
          parsed.data.content,
        );
        return context.json(
          {
            success: true as const,
            data: taskActivityResponse(activity),
            request_id: context.get("requestId"),
          },
          201,
        );
      } catch (error) {
        return taskActivityFailure(context, error);
      }
    },
  );
  app.patch(
    "/api/v1/projects/:projectId/tasks/:taskId/activities/comments/:commentId",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { tasks: ["write"] }),
    async (context) => {
      const taskId = context.req.param("taskId");
      const commentId = context.req.param("commentId");
      const parsed = taskCommentBodySchema.safeParse(await context.req.json().catch(() => null));
      if (
        !z.uuid().safeParse(taskId).success ||
        !z.uuid().safeParse(commentId).success ||
        !parsed.success
      ) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid task comment");
      }
      try {
        const activity = await dependencies.taskActivities.updateComment(
          context.env,
          context.req.param("projectId"),
          taskId,
          commentId,
          context.get("permissionActorId"),
          parsed.data.content,
        );
        return legacySuccess(context, taskActivityResponse(activity));
      } catch (error) {
        return taskActivityFailure(context, error);
      }
    },
  );
  app.delete(
    "/api/v1/projects/:projectId/tasks/:taskId/activities/comments/:commentId",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, { tasks: ["write"] }),
    async (context) => {
      const taskId = context.req.param("taskId");
      const commentId = context.req.param("commentId");
      if (!z.uuid().safeParse(taskId).success || !z.uuid().safeParse(commentId).success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid task comment");
      }
      try {
        await dependencies.taskActivities.deleteComment(
          context.env,
          context.req.param("projectId"),
          taskId,
          commentId,
          context.get("permissionActorId"),
        );
        return legacySuccess(context, { message: "task comment deleted" });
      } catch (error) {
        return taskActivityFailure(context, error);
      }
    },
  );
  app.get("/api/v1/users/me/tasks", (context) =>
    authenticatedPreviewResponse(context, dependencies.currentUserSession, {
      items: [],
      page_size: 10,
      next_cursor: null,
      total_count: 0,
    }),
  );
  app.get("/api/v1/users/me/global-permissions", async (context) => {
    context.header("cache-control", "no-store");
    const snapshot = await dependencies.loadSystemPermissions(context.req.raw, context.env);
    if (!snapshot.authenticated) {
      return context.json(
        {
          success: false as const,
          error_code: "AUTH_UNAUTHENTICATED",
          error: "Authentication required",
          request_id: context.get("requestId"),
        },
        401,
      );
    }

    return legacySuccess(context, {
      permissions: snapshot.grants.map(toLegacyPermissionKey),
    });
  });
  app.get(
    "/api/v1/projects/:projectId/members/me/permissions",
    requireValidProjectId,
    requireProjectPermission(dependencies.authorizeProjectPermission, {
      projects: ["read"],
    }),
    (context) =>
      legacySuccess(context, {
        permissions: Object.fromEntries(
          context.get("permissionGrants").map((grant) => [toLegacyPermissionKey(grant), true]),
        ),
      }),
  );
  app.get(
    "/api/v1/admin/global-roles",
    requireSystemPermission(dependencies.authorizeSystemPermission, {
      globalRoles: ["read"],
    }),
    async (context) => {
      const roles = await dependencies.systemRoles.list(context.env);
      return legacySuccess(context, roles.map(systemRoleResponse));
    },
  );
  app.get(
    "/api/v1/admin/users",
    requireSystemPermission(dependencies.authorizeSystemPermission, { users: ["read"] }),
    async (context) => {
      const parsed = userListQuerySchema.safeParse(context.req.query());
      if (!parsed.success) return legacyFailure(context, 400, "BAD_REQUEST", "Invalid pagination");
      const result = await dependencies.projectAccess.listUsers(
        context.env,
        parsed.data.page,
        parsed.data.page_size,
      );
      return legacySuccess(context, {
        items: result.items.map((item) => ({
          id: item.id,
          username: item.email.split("@")[0] || item.name,
          full_name: item.name,
          email: item.email,
          role: "user",
          must_change_password: false,
          avatar_url: item.image,
          avatar_thumb_url: item.image,
          created_at: item.createdAt.toISOString(),
        })),
        total: result.total,
        page: result.page,
        page_size: result.pageSize,
      });
    },
  );
  app.post(
    "/api/v1/admin/global-roles",
    requireSystemPermission(dependencies.authorizeSystemPermission, {
      globalRoles: ["write"],
    }),
    async (context) => {
      const body = await readSystemRoleBody(context);
      if (!body) return legacyFailure(context, 400, "BAD_REQUEST", "Invalid request body");

      try {
        const role = await dependencies.systemRoles.create(
          context.env,
          context.get("permissionGrants"),
          body,
        );
        return context.json(
          {
            success: true as const,
            data: systemRoleResponse(role),
            request_id: context.get("requestId"),
          },
          201,
        );
      } catch (error) {
        return systemRoleFailure(context, error);
      }
    },
  );
  app.patch(
    "/api/v1/admin/global-roles/:roleId",
    requireSystemPermission(dependencies.authorizeSystemPermission, {
      globalRoles: ["write"],
    }),
    async (context) => {
      const roleId = context.req.param("roleId");
      if (!z.uuid().safeParse(roleId).success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid role id");
      }
      const body = await readSystemRoleBody(context);
      if (!body) return legacyFailure(context, 400, "BAD_REQUEST", "Invalid request body");

      try {
        const role = await dependencies.systemRoles.update(
          context.env,
          context.get("permissionGrants"),
          roleId,
          body,
        );
        return legacySuccess(context, systemRoleResponse(role));
      } catch (error) {
        return systemRoleFailure(context, error);
      }
    },
  );
  app.delete(
    "/api/v1/admin/global-roles/:roleId",
    requireSystemPermission(dependencies.authorizeSystemPermission, {
      globalRoles: ["write"],
    }),
    async (context) => {
      const roleId = context.req.param("roleId");
      if (!z.uuid().safeParse(roleId).success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid role id");
      }

      try {
        await dependencies.systemRoles.delete(context.env, roleId);
        return legacySuccess(context, { message: "global role deleted" });
      } catch (error) {
        return systemRoleFailure(context, error);
      }
    },
  );
  app.put(
    "/api/v1/admin/users/:userId/global-roles",
    requireSystemPermission(dependencies.authorizeSystemPermission, {
      globalRoles: ["assign"],
    }),
    async (context) => {
      const userId = context.req.param("userId").trim();
      const body = await context.req.json().catch(() => null);
      const parsed = systemRoleAssignmentBodySchema.safeParse(body);
      if (!userId || !parsed.success) {
        return legacyFailure(context, 400, "BAD_REQUEST", "Invalid role assignment");
      }

      try {
        const roles = await dependencies.systemRoles.replaceUserRoles(
          context.env,
          context.get("permissionGrants"),
          userId,
          parsed.data.role_ids,
        );
        return legacySuccess(context, {
          user_id: userId,
          roles: roles.map(systemRoleResponse),
        });
      } catch (error) {
        return systemRoleFailure(context, error);
      }
    },
  );
  app.get("/api/v1/users/me/notifications", (context) =>
    authenticatedPreviewResponse(context, dependencies.currentUserSession, {
      items: [],
      page_size: 20,
      next_cursor: null,
      unread_count: 0,
    }),
  );
  app.get("/api/v1/plugins", (context) =>
    authenticatedPreviewResponse(context, dependencies.currentUserSession, []),
  );

  app.get("/internal/health/database", async (context) => {
    context.header("cache-control", "no-store");
    const configuredToken = context.env.INTERNAL_HEALTH_TOKEN;
    if (!configuredToken) {
      return context.json(
        {
          status: "unavailable",
          code: "INTERNAL_HEALTH_TOKEN_NOT_CONFIGURED",
          requestId: context.get("requestId"),
        },
        503,
      );
    }

    const providedToken = readBearerToken(context.req.header("authorization"));
    if (!providedToken || !(await constantTimeEqual(configuredToken, providedToken))) {
      return context.json(
        {
          status: "unauthorized",
          code: "UNAUTHORIZED",
          requestId: context.get("requestId"),
        },
        401,
      );
    }

    const health = await dependencies.databaseHealth(context.env);
    return context.json({
      status: "ok",
      dependency: "postgresql",
      connection: "hyperdrive",
      latencyMs: health.latencyMs,
      requestId: context.get("requestId"),
    });
  });

  app.notFound((context) =>
    context.json(
      {
        status: "not_found",
        code: "NOT_FOUND",
        requestId: context.get("requestId"),
      },
      404,
    ),
  );

  app.onError((error, context) => {
    dependencies.log({
      level: "error",
      message: "request.failed",
      requestId: context.get("requestId"),
      errorName: error.name,
    });

    return context.json(
      {
        status: "error",
        code: "INTERNAL_ERROR",
        requestId: context.get("requestId"),
      },
      500,
    );
  });

  return app;
}
