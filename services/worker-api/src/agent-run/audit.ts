import type { PacaDatabase } from "../database";
import { pacaAgentAuthAudit } from "../db/schema";
import type { DocumentAgentCommandResult } from "../document/agent-operations";
import type { DocumentAgentWorkflowParams } from "./document-workflow-protocol";

export type DocumentWorkflowAuditStatus = "succeeded" | "failed";

export function documentWorkflowAuditValues(
  params: DocumentAgentWorkflowParams,
  status: DocumentWorkflowAuditStatus,
  result?: DocumentAgentCommandResult,
  errorCode?: string,
) {
  return {
    id: crypto.randomUUID(),
    eventType: "agent.workflow.document.executed",
    actorType: "agent",
    actorId: params.agentId,
    agentId: params.agentId,
    hostId: null,
    targetType: "document",
    targetId: params.documentId,
    capability: "document.edit",
    executionStatus: status,
    durationMs: null,
    metadata: {
      runId: params.runId,
      requestId: params.idempotencyKey,
      workflowId: params.workflowId,
      workflowGrantId: params.workflowGrantId,
      documentGrantId: params.documentGrantId,
      organizationId: params.organizationId,
      projectId: params.projectId,
      documentId: params.documentId,
      action: params.command.action,
      operationMode: params.command.operationMode,
      ...(result
        ? {
            result: {
              action: result.action,
              conflict: result.conflict,
              revision: result.revision,
            },
          }
        : {}),
      ...(errorCode ? { errorCode } : {}),
    },
  } as const;
}

export async function recordDocumentWorkflowExecution(
  database: PacaDatabase,
  params: DocumentAgentWorkflowParams,
  status: DocumentWorkflowAuditStatus,
  result?: DocumentAgentCommandResult,
  errorCode?: string,
) {
  await database
    .insert(pacaAgentAuthAudit)
    .values(documentWorkflowAuditValues(params, status, result, errorCode));
}
