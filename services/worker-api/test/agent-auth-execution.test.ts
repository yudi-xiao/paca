import type { AgentSession, CapabilityConstraints } from "@better-auth/agent-auth";
import { describe, expect, it, vi } from "vitest";

import {
  createPacaAgentExecutor,
  type PacaAgentExecutionDependencies,
} from "../src/agent-auth/execution";
import type { Project } from "../src/project/service";
import type { Task, TaskActor } from "../src/task/service";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date();

const project: Project = {
  id: PROJECT_ID,
  organizationId: "paca-default",
  name: "Project",
  description: "",
  taskIdPrefix: "PROJ",
  isPublic: false,
  settings: {},
  createdBy: "user-1",
  createdAt: NOW,
  updatedAt: NOW,
};

const task: Task = {
  id: TASK_ID,
  projectId: PROJECT_ID,
  taskNumber: 1,
  taskTypeId: null,
  statusId: null,
  sprintId: null,
  parentTaskId: null,
  title: "Task",
  description: null,
  importance: 0,
  storyPoints: null,
  assigneeIds: [],
  reporterId: null,
  customFields: {},
  startDate: null,
  dueDate: null,
  tags: [],
  viewPosition: null,
  viewGroupKey: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function agentSession(capability: string, constraints: CapabilityConstraints): AgentSession {
  return {
    type: "delegated",
    agentId: "agent-1",
    userId: "user-1",
    agent: {
      id: "agent-1",
      name: "Agent",
      mode: "delegated",
      capabilityGrants: [{ capability, constraints, grantedBy: "approver-1", status: "active" }],
      hostId: "host-1",
      createdAt: NOW,
      activatedAt: NOW,
      metadata: null,
    },
    host: { id: "host-1", userId: "user-1", status: "active" },
    user: { id: "user-1", name: "User", email: "user@paca.test" },
  };
}

function autonomousSession(capability: string, constraints: CapabilityConstraints): AgentSession {
  return {
    ...agentSession(capability, constraints),
    type: "autonomous",
    userId: null,
    agent: {
      ...agentSession(capability, constraints).agent,
      mode: "autonomous",
    },
    host: { id: "host-1", userId: null, status: "active" },
    user: {
      id: "agent:agent-1",
      name: "Autonomous agent",
      email: "agent-1@agents.invalid",
    },
  };
}

function dependencies(
  overrides: Partial<PacaAgentExecutionDependencies> = {},
): PacaAgentExecutionDependencies {
  return {
    findProjectOrganization: async () => "paca-default",
    hasProjectPermission: async () => ({ allowed: true, scopeExists: true }),
    getProject: async () => project,
    getTask: async () => task,
    createTask: async (_projectId, _actor, input) => ({
      ...task,
      title: input.title,
      description: (input.description as unknown[] | undefined) ?? null,
    }),
    updateTask: async (_projectId, _taskId, _actor, input) => ({
      ...task,
      title: input.title ?? task.title,
    }),
    ...overrides,
  };
}

function executeContext(
  capability: "project.read" | "task.read" | "task.write" | "task.create",
  session: AgentSession,
  args: Record<string, unknown>,
) {
  return {
    ctx: {} as never,
    capability,
    capabilityDef: { name: capability, description: capability },
    arguments: args,
    agentSession: session,
    grant: {
      id: "grant-1",
      agentId: session.agentId,
      capability,
      constraints: session.agent.capabilityGrants[0]?.constraints ?? null,
      grantedBy: "approver-1",
      deniedBy: null,
      reason: null,
      expiresAt: new Date(Date.now() + 60_000),
      status: "active" as const,
      createdAt: NOW,
      updatedAt: NOW,
    },
    revokeGrant: async () => undefined,
  };
}

const scope = {
  organizationId: "paca-default",
  projectId: PROJECT_ID,
  validUntil: new Date(Date.now() + 60_000).toISOString(),
};

describe("Paca Agent Auth execution boundary", () => {
  it("intersects project.read with the delegated user's current Paca permission", async () => {
    const hasProjectPermission = vi.fn(async () => ({ allowed: true, scopeExists: true }));
    const executor = createPacaAgentExecutor(dependencies({ hasProjectPermission }));
    const session = agentSession("project.read", scope);

    await expect(executor(executeContext("project.read", session, scope))).resolves.toEqual(
      project,
    );
    expect(hasProjectPermission).toHaveBeenCalledWith("user-1", PROJECT_ID, {
      projects: ["read"],
    });
  });

  it("immediately rejects a delegated agent after the user's permission is removed", async () => {
    const executor = createPacaAgentExecutor(
      dependencies({
        hasProjectPermission: async () => ({ allowed: false, scopeExists: true }),
      }),
    );
    const session = agentSession("task.read", { ...scope, taskId: TASK_ID });

    await expect(
      executor(executeContext("task.read", session, { ...scope, taskId: TASK_ID })),
    ).rejects.toThrow("AGENT_DELEGATED_PERMISSION_DENIED");
  });

  it("keeps suggestion mode non-mutating and attributes a delegated write to the Agent", async () => {
    const updateTask = vi.fn(async (_projectId, _taskId, _actor: TaskActor, input) => ({
      ...task,
      title: input.title ?? task.title,
    }));
    const executor = createPacaAgentExecutor(dependencies({ updateTask }));
    const constraints = {
      ...scope,
      taskId: TASK_ID,
      field: { in: ["title"] },
      operationMode: { in: ["suggest", "collaborate"] },
    } satisfies CapabilityConstraints;
    const session = agentSession("task.write", constraints);

    await expect(
      executor(
        executeContext("task.write", session, {
          ...scope,
          taskId: TASK_ID,
          field: "title",
          operationMode: "suggest",
          value: "Proposed title",
        }),
      ),
    ).resolves.toMatchObject({
      applied: false,
      mode: "suggest",
      update: { title: "Proposed title" },
    });
    expect(updateTask).not.toHaveBeenCalled();

    await expect(
      executor(
        executeContext("task.write", session, {
          ...scope,
          taskId: TASK_ID,
          field: "title",
          operationMode: "collaborate",
          value: "Applied title",
        }),
      ),
    ).resolves.toMatchObject({ title: "Applied title" });
    expect(updateTask).toHaveBeenCalledWith(
      PROJECT_ID,
      TASK_ID,
      { type: "agent", id: "agent-1" },
      {
        title: "Applied title",
      },
    );
  });

  it("updates a task description and creates Backlog work as the delegated Agent", async () => {
    const description = [{ type: "paragraph", content: [{ type: "text", text: "Expanded" }] }];
    const updateTask = vi.fn(async () => ({ ...task, description }));
    const createTask = vi.fn(async (_projectId, _actor: TaskActor, input) => ({
      ...task,
      id: "33333333-3333-4333-8333-333333333333",
      taskNumber: 2,
      title: input.title,
      description: (input.description as unknown[] | undefined) ?? null,
    }));
    const executor = createPacaAgentExecutor(dependencies({ updateTask, createTask }));
    const writeConstraints = {
      ...scope,
      taskId: TASK_ID,
      field: "description",
      operationMode: "collaborate",
    } satisfies CapabilityConstraints;
    const writeSession = agentSession("task.write", writeConstraints);

    await expect(
      executor(
        executeContext("task.write", writeSession, {
          ...writeConstraints,
          value: description,
        }),
      ),
    ).resolves.toMatchObject({ description });
    expect(updateTask).toHaveBeenCalledWith(
      PROJECT_ID,
      TASK_ID,
      { type: "agent", id: "agent-1" },
      {
        description,
      },
    );

    const createConstraints = {
      ...scope,
      operationMode: "collaborate",
    } satisfies CapabilityConstraints;
    const createSession = agentSession("task.create", createConstraints);
    await expect(
      executor(
        executeContext("task.create", createSession, {
          ...createConstraints,
          title: "Create runtime role",
          description,
          tags: ["test-data"],
        }),
      ),
    ).resolves.toMatchObject({ title: "Create runtime role", description });
    expect(createTask).toHaveBeenCalledWith(
      PROJECT_ID,
      { type: "agent", id: "agent-1" },
      {
        title: "Create runtime role",
        description,
        importance: undefined,
        storyPoints: undefined,
        tags: ["test-data"],
      },
    );
  });

  it("rejects a cross-organization project before any domain read", async () => {
    const getProject = vi.fn(async () => project);
    const executor = createPacaAgentExecutor(
      dependencies({ findProjectOrganization: async () => "other-org", getProject }),
    );
    const session = agentSession("project.read", scope);

    await expect(executor(executeContext("project.read", session, scope))).rejects.toThrow(
      "AGENT_PROJECT_SCOPE_MISMATCH",
    );
    expect(getProject).not.toHaveBeenCalled();
  });

  it("allows autonomous project reads from active scoped Grants without impersonating a user", async () => {
    const hasProjectPermission = vi.fn(async () => ({ allowed: false, scopeExists: true }));
    const executor = createPacaAgentExecutor(dependencies({ hasProjectPermission }));
    const session = autonomousSession("project.read", scope);

    await expect(executor(executeContext("project.read", session, scope))).resolves.toEqual(
      project,
    );
    expect(hasProjectPermission).not.toHaveBeenCalled();
  });

  it("applies autonomous writes with a trusted Agent actor instead of impersonating a user", async () => {
    const updateTask = vi.fn(async () => ({ ...task, title: "Autonomous update" }));
    const constraints = {
      ...scope,
      taskId: TASK_ID,
      field: "title",
      operationMode: "collaborate",
    } satisfies CapabilityConstraints;
    const executor = createPacaAgentExecutor(dependencies({ updateTask }));
    const session = autonomousSession("task.write", constraints);

    await expect(
      executor(
        executeContext("task.write", session, {
          ...constraints,
          value: "Autonomous update",
        }),
      ),
    ).resolves.toMatchObject({ title: "Autonomous update" });
    expect(updateTask).toHaveBeenCalledWith(
      PROJECT_ID,
      TASK_ID,
      { type: "agent", id: "agent-1" },
      { title: "Autonomous update" },
    );
  });
});
