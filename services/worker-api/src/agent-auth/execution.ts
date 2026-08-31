import type { AgentAuthOptions, AgentSession } from "@better-auth/agent-auth";
import * as z from "zod";

import type { PacaDatabase } from "../database";
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
import { evaluateAgentCapability, type PacaCapabilityName } from "./capabilities";

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

function denied(code: string): never {
  throw new Error(code);
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
  session: AgentSession,
  capability: PacaCapabilityName,
  input:
    | z.infer<typeof taskWriteSchema>
    | z.infer<typeof taskReadSchema>
    | z.infer<typeof scopeSchema>,
) {
  const decision = evaluateAgentCapability(session, capability, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    taskId: "taskId" in input ? input.taskId : undefined,
    field: "field" in input ? input.field : undefined,
    operationMode: "operationMode" in input ? input.operationMode : undefined,
  });
  if (!decision.allowed) denied(decision.code);
}

export type AgentProjectScope = z.infer<typeof scopeSchema>;

export async function readProjectAsAgent(
  dependencies: PacaAgentExecutionDependencies,
  session: AgentSession,
  input: AgentProjectScope,
): Promise<Project> {
  requireGrant(session, "project.read", input);
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
        return readProjectAsAgent(dependencies, context.agentSession, input);
      }
      case "task.read": {
        const input = taskReadSchema.parse(context.arguments);
        requireGrant(context.agentSession, "task.read", input);
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
        requireGrant(context.agentSession, "task.write", input);
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
        requireGrant(context.agentSession, "task.create", input);
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
      default:
        denied("AGENT_CAPABILITY_NOT_EXECUTABLE");
    }
  };
}

export function createPostgresPacaAgentExecutor(database: PacaDatabase): AgentExecuteHandler {
  const dependencies = postgresPacaAgentExecutionDependencies(database);
  return createPacaAgentExecutor(dependencies);
}

function postgresPacaAgentExecutionDependencies(
  database: PacaDatabase,
): PacaAgentExecutionDependencies {
  const permissionStore = new PostgresPacaPermissionStore(database);
  const permissionService = new PacaPermissionService(permissionStore);
  const projectService = new ProjectService(new PostgresProjectRepository(database));
  const taskService = new TaskService(new PostgresTaskRepository(database));

  return {
    findProjectOrganization: (projectId) => permissionStore.findProjectOrganization(projectId),
    hasProjectPermission: (userId, projectId, permission) =>
      permissionService.hasProjectPermission(userId, projectId, permission),
    getProject: (projectId) => projectService.get(projectId),
    getTask: (projectId, taskId) => taskService.get(projectId, taskId),
    createTask: (projectId, actor, input) => taskService.createAs(projectId, actor, input),
    updateTask: (projectId, taskId, actor, input) =>
      taskService.updateAs(projectId, taskId, actor, input),
  };
}

export function readPostgresProjectAsAgent(
  database: PacaDatabase,
  session: AgentSession,
  input: AgentProjectScope,
): Promise<Project> {
  return readProjectAsAgent(postgresPacaAgentExecutionDependencies(database), session, input);
}
