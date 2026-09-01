import type { CapabilityConstraints } from "@better-auth/agent-auth";
import { describe, expect, it, vi } from "vitest";

import {
  authorizeAndExecuteDocumentWorkflow,
  type DocumentWorkflowAuthorizationDependencies,
  selectDocumentWorkflowGrants,
} from "../src/agent-run/document-workflow-authorization";
import {
  createDocumentAgentWorkflowParams,
  DOCUMENT_AGENT_WORKFLOW_ID,
} from "../src/agent-run/document-workflow-protocol";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const VALID_UNTIL = "2099-01-01T00:00:00.000Z";

const command = {
  action: "acquire_lease" as const,
  requestId: REQUEST_ID,
  runId: RUN_ID,
  operationMode: "exclusive" as const,
  leaseDurationMs: 10_000,
};

function constraints(capability: "workflow.execute" | "document.edit"): CapabilityConstraints {
  return capability === "workflow.execute"
    ? {
        organizationId: "paca-default",
        projectId: PROJECT_ID,
        workflowId: DOCUMENT_AGENT_WORKFLOW_ID,
        operationMode: "execute",
        validUntil: VALID_UNTIL,
      }
    : {
        organizationId: "paca-default",
        projectId: PROJECT_ID,
        documentId: DOCUMENT_ID,
        field: "block.content",
        operationMode: "exclusive",
        action: "acquire_lease",
        validUntil: VALID_UNTIL,
      };
}

function dependencies(
  overrides: Partial<DocumentWorkflowAuthorizationDependencies> = {},
): DocumentWorkflowAuthorizationDependencies {
  const grants = [
    {
      id: "workflow-grant",
      agentId: "agent-1",
      capability: "workflow.execute",
      constraints: constraints("workflow.execute"),
      expiresAt: new Date(VALID_UNTIL),
      status: "active",
    },
    {
      id: "document-grant",
      agentId: "agent-1",
      capability: "document.edit",
      constraints: constraints("document.edit"),
      expiresAt: new Date(VALID_UNTIL),
      status: "active",
    },
  ];
  return {
    loadAgent: async () => ({
      id: "agent-1",
      mode: "delegated",
      status: "active",
      userId: "user-1",
      expiresAt: null,
    }),
    loadGrants: async (_agentId, grantIds) => grants.filter((grant) => grantIds.includes(grant.id)),
    loadCapabilityGrants: async () => grants,
    readDocumentScope: async () => ({ organizationId: "paca-default", projectId: PROJECT_ID }),
    hasDocumentWritePermission: async () => ({ allowed: true, scopeExists: true }),
    executeDocumentCommand: vi.fn(async () => ({
      action: "acquire_lease" as const,
      acquired: true,
      conflict: false,
      documentId: DOCUMENT_ID,
      expiresAt: Date.parse(VALID_UNTIL),
      leaseId: "55555555-5555-4555-8555-555555555555",
      released: false,
      requestId: REQUEST_ID,
      revision: 1,
      runId: RUN_ID,
    })),
    ...overrides,
  };
}

function params() {
  return createDocumentAgentWorkflowParams({
    runId: RUN_ID,
    idempotencyKey: REQUEST_ID,
    agentId: "agent-1",
    agentMode: "delegated",
    delegatedUserId: "user-1",
    workflowId: DOCUMENT_AGENT_WORKFLOW_ID,
    workflowGrantId: "workflow-grant",
    documentGrantId: "document-grant",
    organizationId: "paca-default",
    projectId: PROJECT_ID,
    documentId: DOCUMENT_ID,
    command,
  });
}

describe("Document Agent Workflow authorization", () => {
  it("selects separate workflow.execute and document.edit grants", async () => {
    await expect(selectDocumentWorkflowGrants(dependencies(), params())).resolves.toEqual({
      workflowGrantId: "workflow-grant",
      documentGrantId: "document-grant",
    });
  });

  it("revalidates both grants immediately before the document write", async () => {
    const harness = dependencies();
    await expect(authorizeAndExecuteDocumentWorkflow(harness, params())).resolves.toMatchObject({
      acquired: true,
    });
    expect(harness.executeDocumentCommand).toHaveBeenCalledWith(
      "agent-1",
      DOCUMENT_ID,
      command,
      Date.parse(VALID_UNTIL),
    );
  });

  it("fails closed when a selected grant is revoked after the run is queued", async () => {
    const harness = dependencies({
      loadGrants: async () => [
        {
          id: "workflow-grant",
          agentId: "agent-1",
          capability: "workflow.execute",
          constraints: constraints("workflow.execute"),
          expiresAt: null,
          status: "revoked",
        },
      ],
    });
    await expect(authorizeAndExecuteDocumentWorkflow(harness, params())).rejects.toThrow(
      "AGENT_GRANT_REVOKED",
    );
    expect(harness.executeDocumentCommand).not.toHaveBeenCalled();
  });

  it("rechecks the delegated user's current project permission", async () => {
    const harness = dependencies({
      hasDocumentWritePermission: async () => ({ allowed: false, scopeExists: true }),
    });
    await expect(authorizeAndExecuteDocumentWorkflow(harness, params())).rejects.toThrow(
      "AGENT_DELEGATED_PERMISSION_DENIED",
    );
    expect(harness.executeDocumentCommand).not.toHaveBeenCalled();
  });
});
