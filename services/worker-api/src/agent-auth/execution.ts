import {
  type AgentAuthOptions,
  type AgentCapabilityGrant,
  type AgentSession,
  agentError,
} from "@better-auth/agent-auth";
import { and, eq, isNull } from "drizzle-orm";
import * as z from "zod";
import { PostgresAgentTaskLeaseRepository } from "../agent-task/postgres-repository";
import {
  type AgentTaskLeaseCommand,
  type AgentTaskLeaseResult,
  agentTaskLeaseCommandSchema,
} from "../agent-task/protocol";
import {
  AgentTaskLeaseError,
  AgentTaskLeaseService,
  agentTaskLeaseErrorCodes,
} from "../agent-task/service";
import type { AppBindings } from "../bindings";
import type { PacaDatabase } from "../database";
import * as schema from "../db/schema";
import {
  type DocumentAgentCommand,
  type DocumentAgentCommandResult,
  type DocumentAgentSnapshot,
  documentAgentCommandSchema,
} from "../document/agent-operations";
import type { DocumentScope } from "../document/postgres-scope-repository";
import { PostgresPacaPermissionStore } from "../permission/postgres-store";
import { PacaPermissionService } from "../permission/service";
import type { PermissionRequest } from "../permission/statement";
import { PostgresProjectRepository } from "../project/postgres-repository";
import { type Project, ProjectService } from "../project/service";
import { PostgresTaskRepository } from "../task/postgres-repository";
import {
  agentTaskActor,
  type Task,
  type TaskActor,
  type TaskCreateInput,
  TaskService,
  type TaskUpdateInput,
} from "../task/service";
import {
  evaluateAgentCapability,
  evaluateAgentCapabilityGrant,
  exactConstraintString,
  type PacaCapabilityName,
} from "./capabilities";

type AgentExecuteHandler = NonNullable<AgentAuthOptions["onExecute"]>;
type AgentExecuteContext = Parameters<AgentExecuteHandler>[0];

export type PacaAgentExecutionDependencies = {
  findProjectOrganization(projectId: string): Promise<string | null>;
  hasProjectPermission(
    userId: string,
    projectId: string,
    permission: PermissionRequest,
  ): Promise<{ allowed: boolean; scopeExists: boolean }>;
  getProject(projectId: string): Promise<Project>;
  getTask(projectId: string, taskId: string): Promise<Task>;
  createTask(projectId: string, actor: TaskActor, input: TaskCreateInput): Promise<Task>;
  updateTask(
    projectId: string,
    taskId: string,
    actor: TaskActor,
    input: TaskUpdateInput,
  ): Promise<Task>;
  executeTaskLease(
    actor: { agentId: string; hostId: string },
    command: AgentTaskLeaseCommand,
    authorizationExpiresAt: Date,
  ): Promise<AgentTaskLeaseResult>;
  findDocumentScope(documentId: string): Promise<DocumentScope | null>;
  readDocument(documentId: string): Promise<DocumentAgentSnapshot>;
  executeDocumentCommand(
    actorId: string,
    documentId: string,
    input: DocumentAgentCommand,
    authorizationExpiresAt: number,
  ): Promise<DocumentAgentCommandResult>;
};

const scopeSchema = z.object({
  organizationId: z.string().min(1).max(255),
  projectId: z.uuid(),
  validUntil: z.iso.datetime(),
});

const taskReadSchema = scopeSchema.extend({ taskId: z.uuid() });
const taskWriteSchema = taskReadSchema.extend({
  field: z.enum([
    "title",
    "description",
    "statusId",
    "sprintId",
    "taskTypeId",
    "importance",
    "storyPoints",
    "startDate",
    "dueDate",
    "tags",
  ]),
  operationMode: z.enum(["suggest", "collaborate"]),
  value: z.unknown(),
});
const taskCreateSchema = scopeSchema.extend({
  operationMode: z.enum(["suggest", "collaborate"]),
  title: z.string().min(1).max(500),
  description: z.array(z.unknown()).optional(),
  importance: z.number().int().min(0).max(1_000_000).optional(),
  storyPoints: z.number().int().min(0).max(1_000_000).nullable().optional(),
  tags: z.array(z.string().max(100)).max(50).optional(),
});
const documentReadSchema = scopeSchema.extend({ documentId: z.uuid() });
const documentCommandEnvelopeSchema = scopeSchema
  .extend({
    documentId: z.uuid(),
    field: z.literal("block.content"),
    action: z.enum(["acquire_lease", "apply", "release_lease", "renew_lease"]),
    operationMode: z.enum(["suggest", "collaborate", "exclusive"]),
  })
  .passthrough();

function denied(code: string): never {
  throw new Error(code);
}

function agentTaskLeaseFailure(error: unknown): never {
  if (!(error instanceof AgentTaskLeaseError)) throw error;
  const status =
    error.code === agentTaskLeaseErrorCodes.inputInvalid
      ? "BAD_REQUEST"
      : error.code === agentTaskLeaseErrorCodes.taskNotFound ||
          error.code === agentTaskLeaseErrorCodes.leaseNotFound
        ? "NOT_FOUND"
        : error.code === agentTaskLeaseErrorCodes.leaseOwnerMismatch ||
            error.code === agentTaskLeaseErrorCodes.leaseScopeMismatch ||
            error.code === agentTaskLeaseErrorCodes.authorizationExpired
          ? "FORBIDDEN"
          : "CONFLICT";
  // Use Agent Auth's own error factory so its batch executor recognizes the
  // error instance and preserves the bounded per-request protocol code.
  throw agentError(status, { code: error.code, message: error.code });
}

function requireDelegatedUser(session: AgentSession): string {
  if (session.type !== "delegated" || !session.userId) denied("AGENT_DELEGATED_USER_REQUIRED");
  return session.userId;
}

function taskUpdate(
  field: z.infer<typeof taskWriteSchema>["field"],
  value: unknown,
): TaskUpdateInput {
  switch (field) {
    case "title":
      return { title: z.string().min(1).max(500).parse(value) };
    case "description":
      return { description: z.array(z.unknown()).parse(value) };
    case "statusId":
      return { statusId: z.union([z.uuid(), z.null()]).parse(value) };
    case "sprintId":
      return { sprintId: z.union([z.uuid(), z.null()]).parse(value) };
    case "taskTypeId":
      return { taskTypeId: z.union([z.uuid(), z.null()]).parse(value) };
    case "importance":
      return { importance: z.number().int().min(0).max(1_000_000).parse(value) };
    case "storyPoints":
      return {
        storyPoints: z.union([z.number().int().min(0).max(1_000_000), z.null()]).parse(value),
      };
    case "startDate":
      return { startDate: z.union([z.iso.date(), z.null()]).parse(value) };
    case "dueDate":
      return { dueDate: z.union([z.iso.date(), z.null()]).parse(value) };
    case "tags":
      return { tags: z.array(z.string().max(100)).max(50).parse(value) };
  }
}

async function requireAgentProjectAccess(
  dependencies: PacaAgentExecutionDependencies,
  session: AgentSession,
  organizationId: string,
  projectId: string,
  permission: PermissionRequest,
) {
  const actualOrganizationId = await dependencies.findProjectOrganization(projectId);
  if (!actualOrganizationId || actualOrganizationId !== organizationId) {
    denied("AGENT_PROJECT_SCOPE_MISMATCH");
  }
  if (session.type === "autonomous") return null;

  const userId = requireDelegatedUser(session);
  const decision = await dependencies.hasProjectPermission(userId, projectId, permission);
  if (!decision.scopeExists) denied("AGENT_PROJECT_NOT_FOUND");
  if (!decision.allowed) denied("AGENT_DELEGATED_PERMISSION_DENIED");
  return userId;
}

function requireGrant(
  grant: AgentCapabilityGrant,
  capability: PacaCapabilityName,
  input: {
    organizationId: string;
    projectId: string;
    taskId?: string;
    documentId?: string;
    field?: string;
    operationMode?: string;
    action?: string;
  },
) {
  const decision = evaluateAgentCapabilityGrant(grant, capability, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    taskId: "taskId" in input ? input.taskId : undefined,
    documentId: "documentId" in input ? input.documentId : undefined,
    field: "field" in input ? input.field : undefined,
    operationMode: "operationMode" in input ? input.operationMode : undefined,
    action: "action" in input ? input.action : undefined,
  });
  if (!decision.allowed) denied(decision.code);
}

function agentAuthorizationExpiresAt(grant: AgentCapabilityGrant): number {
  const constrainedExpiry = Date.parse(exactConstraintString(grant.constraints?.validUntil) ?? "");
  const persistedExpiry = grant.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const expiresAt = Math.min(constrainedExpiry, persistedExpiry);
  if (!Number.isFinite(expiresAt)) denied("AGENT_GRANT_CONSTRAINTS_INVALID");
  return expiresAt;
}

async function requireAgentDocumentAccess(
  dependencies: PacaAgentExecutionDependencies,
  session: AgentSession,
  input: z.infer<typeof documentReadSchema>,
  permission: PermissionRequest,
): Promise<void> {
  const scope = await dependencies.findDocumentScope(input.documentId);
  if (
    !scope ||
    scope.organizationId !== input.organizationId ||
    scope.projectId !== input.projectId
  ) {
    denied("AGENT_DOCUMENT_SCOPE_MISMATCH");
  }
  if (session.type === "autonomous") return;
  const userId = requireDelegatedUser(session);
  const decision = await dependencies.hasProjectPermission(userId, input.projectId, permission);
  if (!decision.scopeExists) denied("AGENT_PROJECT_NOT_FOUND");
  if (!decision.allowed) denied("AGENT_DELEGATED_PERMISSION_DENIED");
}

export type AgentProjectScope = z.infer<typeof scopeSchema>;

export async function readProjectAsAgent(
  dependencies: PacaAgentExecutionDependencies,
  session: AgentSession,
  input: AgentProjectScope,
): Promise<Project> {
  const decision = evaluateAgentCapability(session, "project.read", input);
  if (!decision.allowed) denied(decision.code);
  await requireAgentProjectAccess(dependencies, session, input.organizationId, input.projectId, {
    projects: ["read"],
  });
  return dependencies.getProject(input.projectId);
}

export function createPacaAgentExecutor(
  dependencies: PacaAgentExecutionDependencies,
): AgentExecuteHandler {
  return async (context: AgentExecuteContext) => {
    switch (context.capability) {
      case "project.read": {
        const input = scopeSchema.parse(context.arguments);
        requireGrant(context.grant, "project.read", input);
        await requireAgentProjectAccess(
          dependencies,
          context.agentSession,
          input.organizationId,
          input.projectId,
          { projects: ["read"] },
        );
        return dependencies.getProject(input.projectId);
      }
      case "task.read": {
        const input = taskReadSchema.parse(context.arguments);
        requireGrant(context.grant, "task.read", input);
        await requireAgentProjectAccess(
          dependencies,
          context.agentSession,
          input.organizationId,
          input.projectId,
          { tasks: ["read"] },
        );
        return dependencies.getTask(input.projectId, input.taskId);
      }
      case "task.write": {
        const input = taskWriteSchema.parse(context.arguments);
        requireGrant(context.grant, "task.write", input);
        const userId = await requireAgentProjectAccess(
          dependencies,
          context.agentSession,
          input.organizationId,
          input.projectId,
          { tasks: ["write"] },
        );
        const update = taskUpdate(input.field, input.value);
        if (input.operationMode === "suggest") {
          return { applied: false, mode: "suggest", taskId: input.taskId, update };
        }
        if (context.agentSession.type === "delegated" && !userId) {
          denied("AGENT_DELEGATED_USER_REQUIRED");
        }
        const actor = agentTaskActor(context.agentSession.agentId);
        return dependencies.updateTask(input.projectId, input.taskId, actor, update);
      }
      case "task.create": {
        const input = taskCreateSchema.parse(context.arguments);
        requireGrant(context.grant, "task.create", input);
        const userId = await requireAgentProjectAccess(
          dependencies,
          context.agentSession,
          input.organizationId,
          input.projectId,
          { tasks: ["write"] },
        );
        const create: TaskCreateInput = {
          title: input.title,
          description: input.description,
          importance: input.importance,
          storyPoints: input.storyPoints,
          tags: input.tags,
        };
        if (input.operationMode === "suggest") {
          return { applied: false, mode: "suggest", create };
        }
        if (context.agentSession.type === "delegated" && !userId) {
          denied("AGENT_DELEGATED_USER_REQUIRED");
        }
        return dependencies.createTask(
          input.projectId,
          agentTaskActor(context.agentSession.agentId),
          create,
        );
      }
      case "task.execute": {
        const input = agentTaskLeaseCommandSchema.parse(context.arguments);
        requireGrant(context.grant, "task.execute", input);
        await requireAgentProjectAccess(
          dependencies,
          context.agentSession,
          input.organizationId,
          input.projectId,
          { tasks: ["read"] },
        );
        const host = context.agentSession.host;
        if (!host || context.agentSession.agent.hostId !== host.id) {
          denied("AGENT_HOST_IDENTITY_MISMATCH");
        }
        try {
          return await dependencies.executeTaskLease(
            {
              agentId: context.agentSession.agentId,
              hostId: host.id,
            },
            input,
            new Date(agentAuthorizationExpiresAt(context.grant)),
          );
        } catch (error) {
          return agentTaskLeaseFailure(error);
        }
      }
      case "document.read": {
        const input = documentReadSchema.parse(context.arguments);
        requireGrant(context.grant, "document.read", input);
        await requireAgentDocumentAccess(dependencies, context.agentSession, input, {
          docs: ["read"],
        });
        return dependencies.readDocument(input.documentId);
      }
      case "document.edit": {
        const envelope = documentCommandEnvelopeSchema.parse(context.arguments);
        const {
          organizationId,
          projectId,
          validUntil: _validUntil,
          documentId,
          field,
          ...commandValue
        } = envelope;
        const command = documentAgentCommandSchema.parse(commandValue);
        requireGrant(context.grant, "document.edit", {
          organizationId,
          projectId,
          documentId,
          field,
          operationMode: command.operationMode,
          action: command.action,
        });
        await requireAgentDocumentAccess(dependencies, context.agentSession, envelope, {
          docs: ["write"],
        });
        return dependencies.executeDocumentCommand(
          context.agentSession.agentId,
          documentId,
          command,
          agentAuthorizationExpiresAt(context.grant),
        );
      }
      default:
        denied("AGENT_CAPABILITY_NOT_EXECUTABLE");
    }
  };
}

export function createPostgresPacaAgentExecutor(
  database: PacaDatabase,
  env: AppBindings,
): AgentExecuteHandler {
  const dependencies = postgresPacaAgentExecutionDependencies(database, env);
  return createPacaAgentExecutor(dependencies);
}

function postgresPacaAgentExecutionDependencies(
  database: PacaDatabase,
  env?: AppBindings,
): PacaAgentExecutionDependencies {
  const permissionStore = new PostgresPacaPermissionStore(database);
  const permissionService = new PacaPermissionService(permissionStore);
  const projectService = new ProjectService(new PostgresProjectRepository(database));
  const taskService = new TaskService(new PostgresTaskRepository(database));
  const taskLeaseService = new AgentTaskLeaseService(
    new PostgresAgentTaskLeaseRepository(database),
  );

  return {
    findProjectOrganization: (projectId) => permissionStore.findProjectOrganization(projectId),
    hasProjectPermission: (userId, projectId, permission) =>
      permissionService.hasProjectPermission(userId, projectId, permission),
    getProject: (projectId) => projectService.get(projectId),
    getTask: (projectId, taskId) => taskService.get(projectId, taskId),
    createTask: (projectId, actor, input) => taskService.createAs(projectId, actor, input),
    updateTask: (projectId, taskId, actor, input) =>
      taskService.updateAs(projectId, taskId, actor, input),
    executeTaskLease: (actor, command, authorizationExpiresAt) =>
      taskLeaseService.execute(actor, command, authorizationExpiresAt),
    findDocumentScope: async (documentId) => {
      const [scope] = await database
        .select({
          documentId: schema.pacaDocuments.id,
          organizationId: schema.pacaProjects.organizationId,
          projectId: schema.pacaDocuments.projectId,
        })
        .from(schema.pacaDocuments)
        .innerJoin(schema.pacaProjects, eq(schema.pacaProjects.id, schema.pacaDocuments.projectId))
        .where(
          and(
            eq(schema.pacaDocuments.id, documentId),
            isNull(schema.pacaDocuments.deletedAt),
            eq(schema.pacaProjects.status, "active"),
          ),
        )
        .limit(1);
      return scope ?? null;
    },
    readDocument: (documentId) => {
      if (!env) denied("AGENT_DOCUMENT_RUNTIME_UNAVAILABLE");
      return env.DocumentParty.getByName(documentId).readForAgent();
    },
    executeDocumentCommand: (actorId, documentId, input, authorizationExpiresAt) => {
      if (!env) denied("AGENT_DOCUMENT_RUNTIME_UNAVAILABLE");
      return env.DocumentParty.getByName(documentId).executeAsAgent(
        actorId,
        input,
        authorizationExpiresAt,
      );
    },
  };
}

export function readPostgresProjectAsAgent(
  database: PacaDatabase,
  session: AgentSession,
  input: AgentProjectScope,
): Promise<Project> {
  return readProjectAsAgent(postgresPacaAgentExecutionDependencies(database), session, input);
}
