import type { AgentSession, CapabilityConstraints } from "@better-auth/agent-auth";
import { describe, expect, it, vi } from "vitest";

import {
  createPacaAgentExecutor,
  type PacaAgentExecutionDependencies,
} from "../src/agent-auth/execution";
import type { AgentHarnessKind, AgentTaskLease } from "../src/agent-task/protocol";
import { AgentTaskLeaseError, agentTaskLeaseErrorCodes } from "../src/agent-task/service";
import type {
  DocumentAgentCommand,
  DocumentAgentCommandResult,
  DocumentAgentEditInput,
  DocumentAgentEditResult,
  DocumentAgentLeaseResult,
  DocumentAgentSnapshot,
} from "../src/document/agent-operations";
import type { Project } from "../src/project/service";
import type { Task, TaskActor } from "../src/task/service";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const DOCUMENT_ID = "44444444-4444-4444-8444-444444444444";
const REQUEST_ID = "55555555-5555-4555-8555-555555555555";
const RUN_ID = "66666666-6666-4666-8666-666666666666";
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

const taskLease: AgentTaskLease = {
  id: "77777777-7777-4777-8777-777777777777",
  organizationId: "paca-default",
  projectId: PROJECT_ID,
  taskId: TASK_ID,
  agentId: "agent-1",
  hostId: "host-1",
  harness: { kind: "cloudflare-agent", version: null, instanceId: null },
  status: "active",
  version: 1,
  lastCheckpointSequence: 0,
  leaseExpiresAt: new Date(Date.now() + 30_000),
  claimedAt: NOW,
  finishedAt: null,
  errorCode: null,
  resultSummary: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const documentSnapshot: DocumentAgentSnapshot = {
  documentId: DOCUMENT_ID,
  revision: 7,
  stateVector: "c3RhdGU",
  blocks: [
    {
      blockId: "block-a",
      version: "dmVyc2lvbg",
      blockJson: JSON.stringify({
        id: "block-a",
        type: "paragraph",
        props: {},
        content: [],
      }),
    },
  ],
};

const documentEdit: DocumentAgentEditInput = {
  action: "apply",
  requestId: REQUEST_ID,
  runId: RUN_ID,
  baseRevision: 7,
  baseStateVector: "c3RhdGU",
  operationMode: "collaborate",
  operations: [
    {
      type: "replace_block_content",
      blockId: "block-a",
      expectedBlockVersion: "dmVyc2lvbg",
      content: [{ type: "text", text: "Agent edit", styles: {} }],
    },
  ],
};

const documentEditResult: DocumentAgentEditResult = {
  action: "apply",
  applied: true,
  conflict: false,
  documentId: DOCUMENT_ID,
  requestId: REQUEST_ID,
  runId: RUN_ID,
  mode: "collaborate",
  baseRevision: 7,
  revision: 8,
  stateVector: "bmV3LXN0YXRl",
  targets: [{ blockId: "block-a", version: "bmV3LXZlcnNpb24" }],
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
    executeTaskLease: async () => {
      throw new Error("AGENT_TASK_LEASE_NOT_CONFIGURED");
    },
    findDocumentScope: async () => ({
      documentId: DOCUMENT_ID,
      organizationId: "paca-default",
      projectId: PROJECT_ID,
    }),
    readDocument: async () => documentSnapshot,
    executeDocumentCommand: async () => documentEditResult,
    ...overrides,
  };
}

function executeContext(
  capability:
    | "project.read"
    | "task.read"
    | "task.write"
    | "task.create"
    | "task.execute"
    | "document.read"
    | "document.edit",
  session: AgentSession,
  args: Record<string, unknown>,
  grantConstraints = session.agent.capabilityGrants[0]?.constraints ?? null,
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
      constraints: grantConstraints,
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

  it.each([
    "cloudflare-agent",
    "codex",
    "claude-code",
    "deepseek",
  ] satisfies AgentHarnessKind[])("uses the same task.execute contract for the %s Harness", async (kind) => {
    const executeTaskLease = vi.fn(async (_actor, command) => ({
      duplicate: false,
      lease: {
        ...taskLease,
        harness: { kind: command.harness.kind, version: null, instanceId: null },
      },
    }));
    const hasProjectPermission = vi.fn(async () => ({ allowed: true, scopeExists: true }));
    const executor = createPacaAgentExecutor(
      dependencies({ executeTaskLease, hasProjectPermission }),
    );
    const constraints = {
      ...scope,
      taskId: TASK_ID,
      operationMode: "execute",
      action: { in: ["claim", "renew", "checkpoint", "complete", "fail", "cancel_ack"] },
    } satisfies CapabilityConstraints;
    const session = agentSession("task.execute", constraints);
    const command = {
      ...scope,
      taskId: TASK_ID,
      operationMode: "execute" as const,
      action: "claim" as const,
      requestId: REQUEST_ID,
      leaseDurationMs: 30_000,
      harness: { kind },
    };

    await expect(executor(executeContext("task.execute", session, command))).resolves.toMatchObject(
      { lease: { harness: { kind } } },
    );
    expect(executeTaskLease).toHaveBeenCalledWith(
      { agentId: "agent-1", hostId: "host-1" },
      command,
      expect.any(Date),
    );
    expect(hasProjectPermission).toHaveBeenCalledWith("user-1", PROJECT_ID, {
      tasks: ["read"],
    });
  });

  it("exposes bounded task lease protocol errors through Agent Auth", async () => {
    const executor = createPacaAgentExecutor(
      dependencies({
        executeTaskLease: async () => {
          throw new AgentTaskLeaseError(agentTaskLeaseErrorCodes.leaseConflict);
        },
      }),
    );
    const constraints = {
      ...scope,
      taskId: TASK_ID,
      operationMode: "execute",
      action: "claim",
    } satisfies CapabilityConstraints;
    const command = {
      ...constraints,
      requestId: REQUEST_ID,
      leaseDurationMs: 30_000,
      harness: { kind: "codex" },
    };

    await expect(
      executor(executeContext("task.execute", agentSession("task.execute", constraints), command)),
    ).rejects.toMatchObject({
      status: "CONFLICT",
      body: {
        error: agentTaskLeaseErrorCodes.leaseConflict,
        message: agentTaskLeaseErrorCodes.leaseConflict,
      },
    });
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

  it("reads only the exact scoped document and intersects delegated docs.read", async () => {
    const hasProjectPermission = vi.fn(async () => ({ allowed: true, scopeExists: true }));
    const readDocument = vi.fn(async () => documentSnapshot);
    const executor = createPacaAgentExecutor(dependencies({ hasProjectPermission, readDocument }));
    const constraints = { ...scope, documentId: DOCUMENT_ID } satisfies CapabilityConstraints;
    const session = agentSession("document.read", constraints);

    await expect(executor(executeContext("document.read", session, constraints))).resolves.toEqual(
      documentSnapshot,
    );
    expect(hasProjectPermission).toHaveBeenCalledWith("user-1", PROJECT_ID, {
      docs: ["read"],
    });
    expect(readDocument).toHaveBeenCalledWith(DOCUMENT_ID);

    const wrongScopeExecutor = createPacaAgentExecutor(
      dependencies({
        findDocumentScope: async () => ({
          documentId: DOCUMENT_ID,
          organizationId: "other-org",
          projectId: PROJECT_ID,
        }),
      }),
    );
    await expect(
      wrongScopeExecutor(executeContext("document.read", session, constraints)),
    ).rejects.toThrow("AGENT_DOCUMENT_SCOPE_MISMATCH");
  });

  it("executes a constrained document edit with the trusted Agent identity", async () => {
    const executeDocumentCommand = vi.fn(
      async (
        _actorId: string,
        _documentId: string,
        _input: DocumentAgentCommand,
        _authorizationExpiresAt: number,
      ): Promise<DocumentAgentCommandResult> => documentEditResult,
    );
    const hasProjectPermission = vi.fn(async () => ({ allowed: true, scopeExists: true }));
    const executor = createPacaAgentExecutor(
      dependencies({ executeDocumentCommand, hasProjectPermission }),
    );
    const constraints = {
      ...scope,
      documentId: DOCUMENT_ID,
      field: "block.content",
      operationMode: { in: ["suggest", "collaborate"] },
      action: "apply",
    } satisfies CapabilityConstraints;
    const session = agentSession("document.edit", constraints);
    const arguments_ = {
      ...scope,
      documentId: DOCUMENT_ID,
      field: "block.content",
      ...documentEdit,
    };

    await expect(executor(executeContext("document.edit", session, arguments_))).resolves.toEqual(
      documentEditResult,
    );
    expect(hasProjectPermission).toHaveBeenCalledWith("user-1", PROJECT_ID, {
      docs: ["write"],
    });
    expect(executeDocumentCommand).toHaveBeenCalledWith(
      "agent-1",
      DOCUMENT_ID,
      documentEdit,
      expect.any(Number),
    );
  });

  it("rejects revoked delegated document permission and allows an autonomous scoped Grant", async () => {
    const constraints = {
      ...scope,
      documentId: DOCUMENT_ID,
      field: "block.content",
      operationMode: "collaborate",
      action: "apply",
    } satisfies CapabilityConstraints;
    const arguments_ = {
      ...scope,
      documentId: DOCUMENT_ID,
      field: "block.content",
      ...documentEdit,
    };
    const deniedExecutor = createPacaAgentExecutor(
      dependencies({
        hasProjectPermission: async () => ({ allowed: false, scopeExists: true }),
      }),
    );
    await expect(
      deniedExecutor(
        executeContext("document.edit", agentSession("document.edit", constraints), arguments_),
      ),
    ).rejects.toThrow("AGENT_DELEGATED_PERMISSION_DENIED");

    const hasProjectPermission = vi.fn(async () => ({ allowed: false, scopeExists: true }));
    const executeDocumentCommand = vi.fn(async () => documentEditResult);
    const autonomousExecutor = createPacaAgentExecutor(
      dependencies({ hasProjectPermission, executeDocumentCommand }),
    );
    await expect(
      autonomousExecutor(
        executeContext(
          "document.edit",
          autonomousSession("document.edit", constraints),
          arguments_,
        ),
      ),
    ).resolves.toEqual(documentEditResult);
    expect(hasProjectPermission).not.toHaveBeenCalled();
  });

  it("executes an exclusive lease command only within action-scoped document Grants", async () => {
    const leaseResult: DocumentAgentLeaseResult = {
      action: "acquire_lease",
      acquired: true,
      conflict: false,
      documentId: DOCUMENT_ID,
      expiresAt: Date.now() + 30_000,
      leaseId: "77777777-7777-4777-8777-777777777777",
      released: false,
      requestId: REQUEST_ID,
      revision: 7,
      runId: RUN_ID,
    };
    const executeDocumentCommand = vi.fn(async () => leaseResult);
    const executor = createPacaAgentExecutor(dependencies({ executeDocumentCommand }));
    const constraints = {
      ...scope,
      documentId: DOCUMENT_ID,
      field: "block.content",
      operationMode: "exclusive",
      action: { in: ["acquire_lease", "renew_lease", "apply", "release_lease"] },
    } satisfies CapabilityConstraints;
    const session = agentSession("document.edit", constraints);
    const command = {
      action: "acquire_lease" as const,
      requestId: REQUEST_ID,
      runId: RUN_ID,
      operationMode: "exclusive" as const,
      leaseDurationMs: 30_000,
    };

    await expect(
      executor(
        executeContext("document.edit", session, {
          ...scope,
          documentId: DOCUMENT_ID,
          field: "block.content",
          ...command,
        }),
      ),
    ).resolves.toEqual(leaseResult);
    expect(executeDocumentCommand).toHaveBeenCalledWith(
      "agent-1",
      DOCUMENT_ID,
      command,
      expect.any(Number),
    );

    const multiGrantSession = agentSession("document.edit", {
      ...constraints,
      operationMode: "collaborate",
      action: "apply",
    });
    multiGrantSession.agent.capabilityGrants.push({
      capability: "document.edit",
      constraints,
      grantedBy: "approver-1",
      status: "active",
    });
    await expect(
      executor(
        executeContext(
          "document.edit",
          multiGrantSession,
          {
            ...scope,
            documentId: DOCUMENT_ID,
            field: "block.content",
            ...command,
          },
          constraints,
        ),
      ),
    ).resolves.toEqual(leaseResult);

    const applyOnly = agentSession("document.edit", {
      ...constraints,
      action: "apply",
    });
    await expect(
      executor(
        executeContext("document.edit", applyOnly, {
          ...scope,
          documentId: DOCUMENT_ID,
          field: "block.content",
          ...command,
        }),
      ),
    ).rejects.toThrow("AGENT_GRANT_CONSTRAINT_MISMATCH");
  });
});
