import { describe, expect, it } from "vitest";

import { documentWorkflowAuditValues } from "../src/agent-run/audit";
import {
  createDocumentAgentWorkflowParams,
  DOCUMENT_AGENT_WORKFLOW_ID,
} from "../src/agent-run/document-workflow-protocol";

describe("Document Agent Workflow audit", () => {
  it("records trusted scope and outcome without document operation content", () => {
    const params = createDocumentAgentWorkflowParams({
      runId: "11111111-1111-4111-8111-111111111111",
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
      agentId: "agent-1",
      agentMode: "delegated",
      delegatedUserId: "user-1",
      workflowId: DOCUMENT_AGENT_WORKFLOW_ID,
      workflowGrantId: "workflow-grant",
      documentGrantId: "document-grant",
      organizationId: "paca-default",
      projectId: "33333333-3333-4333-8333-333333333333",
      documentId: "44444444-4444-4444-8444-444444444444",
      command: {
        action: "acquire_lease",
        requestId: "22222222-2222-4222-8222-222222222222",
        runId: "11111111-1111-4111-8111-111111111111",
        operationMode: "exclusive",
        leaseDurationMs: 10_000,
      },
    });
    const values = documentWorkflowAuditValues(params, "failed", undefined, "AGENT_GRANT_REVOKED");
    expect(values).toMatchObject({
      actorType: "agent",
      actorId: "agent-1",
      targetType: "document",
      targetId: params.documentId,
      capability: "document.edit",
      executionStatus: "failed",
      metadata: {
        runId: params.runId,
        errorCode: "AGENT_GRANT_REVOKED",
      },
    });
    expect(JSON.stringify(values)).not.toContain("leaseDurationMs");
    expect(JSON.stringify(values)).not.toContain("operations");
  });
});
