import type { AgentSession } from "@better-auth/agent-auth";
import { evaluateAgentCapability } from "../agent-auth/capabilities";
import type { AppBindings } from "../bindings";
import { withDatabase } from "../database";
import {
  AgentWorkflowAuthorizationError,
  type DocumentWorkflowGrantSelection,
  postgresDocumentWorkflowDependencies,
  selectDocumentWorkflowGrants,
} from "./document-workflow-authorization";
import {
  createDocumentAgentWorkflowParams,
  DOCUMENT_AGENT_WORKFLOW_ID,
  type DocumentAgentWorkflowStart,
  documentAgentWorkflowRequestHash,
  documentAgentWorkflowStartSchema,
} from "./document-workflow-protocol";
import type { AgentRunRecord } from "./protocol";

export class AgentRunError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 | 500,
  ) {
    super(code);
    this.name = "AgentRunError";
  }
}

function capabilityDenied(code: string): never {
  throw new AgentRunError(code, 403);
}

function requireSessionCapability(
  session: AgentSession,
  capability: "workflow.execute" | "document.edit",
  context: Parameters<typeof evaluateAgentCapability>[2],
) {
  const decision = evaluateAgentCapability(session, capability, context);
  if (!decision.allowed) capabilityDenied(decision.code);
}

function coordinatorFailure(code: string): never {
  const status = code.includes("NOT_FOUND") ? 404 : code.includes("CONFLICT") ? 409 : 400;
  throw new AgentRunError(code, status);
}

function requireOwnedRun(run: AgentRunRecord | null, agentId: string, projectId: string) {
  if (!run) throw new AgentRunError("AGENT_RUN_NOT_FOUND", 404);
  if (run.agentId !== agentId || run.projectId !== projectId) {
    throw new AgentRunError("AGENT_RUN_SCOPE_MISMATCH", 403);
  }
  return run;
}

export type AgentRunRuntime = {
  startDocumentWorkflow(
    env: AppBindings,
    session: AgentSession,
    projectId: string,
    value: DocumentAgentWorkflowStart,
  ): Promise<AgentRunRecord>;
  getRun(
    env: AppBindings,
    session: AgentSession,
    projectId: string,
    runId: string,
  ): Promise<AgentRunRecord>;
  cancelRun(
    env: AppBindings,
    session: AgentSession,
    projectId: string,
    runId: string,
  ): Promise<AgentRunRecord>;
};

function requireRunCapability(session: AgentSession, projectId: string) {
  requireSessionCapability(session, "workflow.execute", {
    projectId,
    workflowId: DOCUMENT_AGENT_WORKFLOW_ID,
    operationMode: "execute",
  });
}

export const agentRunRuntime: AgentRunRuntime = {
  async startDocumentWorkflow(env, session, projectId, value) {
    const input = documentAgentWorkflowStartSchema.parse(value);
    if (input.command.runId.length === 0) throw new AgentRunError("AGENT_RUN_INPUT_INVALID", 400);
    requireSessionCapability(session, "workflow.execute", {
      organizationId: input.organizationId,
      projectId,
      workflowId: DOCUMENT_AGENT_WORKFLOW_ID,
      operationMode: "execute",
    });
    requireSessionCapability(session, "document.edit", {
      organizationId: input.organizationId,
      projectId,
      documentId: input.documentId,
      field: "block.content",
      operationMode: input.command.operationMode,
      action: input.command.action,
    });

    let selection: DocumentWorkflowGrantSelection;
    try {
      selection = await withDatabase(env, (database) =>
        selectDocumentWorkflowGrants(postgresDocumentWorkflowDependencies(database, env), {
          agentId: session.agentId,
          agentMode: session.type,
          delegatedUserId: session.type === "delegated" ? session.userId : null,
          workflowId: DOCUMENT_AGENT_WORKFLOW_ID,
          organizationId: input.organizationId,
          projectId,
          documentId: input.documentId,
          command: input.command,
        }),
      );
    } catch (error) {
      if (error instanceof AgentWorkflowAuthorizationError) capabilityDenied(error.code);
      throw error;
    }

    const params = createDocumentAgentWorkflowParams({
      runId: input.command.runId,
      idempotencyKey: input.command.requestId,
      agentId: session.agentId,
      agentMode: session.type,
      delegatedUserId: session.type === "delegated" ? session.userId : null,
      workflowId: DOCUMENT_AGENT_WORKFLOW_ID,
      ...selection,
      organizationId: input.organizationId,
      projectId,
      documentId: input.documentId,
      command: input.command,
    });
    const coordinator = env.AgentCoordinator.getByName(session.agentId);
    const requestHash = await documentAgentWorkflowRequestHash(input);
    const created = await coordinator.createRun({
      runId: params.runId,
      idempotencyKey: params.idempotencyKey,
      requestHash,
      agentId: params.agentId,
      workflowId: params.workflowId,
      organizationId: params.organizationId,
      projectId: params.projectId,
      documentId: params.documentId,
      kind: "document.edit",
    });
    if (!created.success) coordinatorFailure(created.errorCode);

    await env.DOCUMENT_AGENT_WORKFLOW.createBatch([
      {
        id: params.runId,
        params,
        retention: { successRetention: "7 days", errorRetention: "14 days" },
      },
    ]);
    return created.run;
  },

  async getRun(env, session, projectId, runId) {
    requireRunCapability(session, projectId);
    return requireOwnedRun(
      await env.AgentCoordinator.getByName(session.agentId).getRun(runId),
      session.agentId,
      projectId,
    );
  },

  async cancelRun(env, session, projectId, runId) {
    requireRunCapability(session, projectId);
    const coordinator = env.AgentCoordinator.getByName(session.agentId);
    let run = requireOwnedRun(await coordinator.getRun(runId), session.agentId, projectId);
    if (["cancelled", "succeeded", "failed"].includes(run.status)) return run;

    if (run.status === "running" || run.status === "waiting") {
      const requested = await coordinator.transitionRun({
        transitionId: crypto.randomUUID(),
        runId,
        status: "cancelling",
      });
      if (requested.success) run = requested.run;
    }
    const instance = await env.DOCUMENT_AGENT_WORKFLOW.get(runId);
    await instance.terminate();
    const cancelled = await coordinator.transitionRun({
      transitionId: crypto.randomUUID(),
      runId,
      status: "cancelled",
    });
    if (!cancelled.success) {
      const current = await coordinator.getRun(runId);
      if (current) return current;
      coordinatorFailure(cancelled.errorCode);
    }
    return cancelled.run;
  },
};
