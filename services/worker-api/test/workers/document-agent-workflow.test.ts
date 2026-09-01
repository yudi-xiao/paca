/// <reference types="@cloudflare/vitest-plugin/types" />

import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  createDocumentAgentWorkflowParams,
  DOCUMENT_AGENT_WORKFLOW_ID,
} from "../../src/agent-run/document-workflow-protocol";

const AGENT_ID = "workflow-agent-1";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";

function params(runId: string, idempotencyKey: string) {
  return createDocumentAgentWorkflowParams({
    runId,
    idempotencyKey,
    agentId: AGENT_ID,
    agentMode: "delegated",
    delegatedUserId: "user-1",
    workflowId: DOCUMENT_AGENT_WORKFLOW_ID,
    workflowGrantId: "workflow-grant",
    documentGrantId: "document-grant",
    organizationId: "paca-default",
    projectId: PROJECT_ID,
    documentId: DOCUMENT_ID,
    command: {
      action: "acquire_lease",
      requestId: idempotencyKey,
      runId,
      operationMode: "exclusive",
      leaseDurationMs: 10_000,
    },
  });
}

async function createCoordinatorRun(input: ReturnType<typeof params>) {
  const result = await env.AgentCoordinator.getByName(input.agentId).createRun({
    runId: input.runId,
    idempotencyKey: input.idempotencyKey,
    requestHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    agentId: input.agentId,
    workflowId: input.workflowId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    documentId: input.documentId,
    kind: "document.edit",
  });
  expect(result.success).toBe(true);
}

describe("DocumentAgentWorkflow runtime", () => {
  it("retries a transient step failure and finishes the coordinator run once", async () => {
    const input = params(
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    );
    await createCoordinatorRun(input);
    const introspector = await introspectWorkflowInstance(env.DOCUMENT_AGENT_WORKFLOW, input.runId);
    try {
      await introspector.modify(async (modifier) => {
        await modifier.disableRetryDelays();
        await modifier.mockStepError({ name: "mark-run-running" }, new Error("transient"), 1);
        await modifier.mockStepResult(
          { name: "authorize-and-apply-document-command" },
          {
            action: "acquire_lease",
            acquired: true,
            conflict: false,
            documentId: DOCUMENT_ID,
            expiresAt: 1,
            leaseId: "55555555-5555-4555-8555-555555555555",
            released: false,
            requestId: input.idempotencyKey,
            revision: 1,
            runId: input.runId,
          },
        );
      });
      await env.DOCUMENT_AGENT_WORKFLOW.create({ id: input.runId, params: input });
      await introspector.waitForStatus("complete");
      await expect(introspector.getOutput()).resolves.toMatchObject({ acquired: true });
      await expect(
        env.AgentCoordinator.getByName(AGENT_ID).getRun(input.runId),
      ).resolves.toMatchObject({ status: "succeeded", version: 3 });
    } finally {
      await introspector.dispose();
    }
  });

  it("records a stable failure code after an authoritative Grant rejection", async () => {
    const input = params(
      "66666666-6666-4666-8666-666666666666",
      "77777777-7777-4777-8777-777777777777",
    );
    await createCoordinatorRun(input);
    const introspector = await introspectWorkflowInstance(env.DOCUMENT_AGENT_WORKFLOW, input.runId);
    try {
      await introspector.modify(async (modifier) => {
        await modifier.disableRetryDelays();
        await modifier.mockStepError(
          { name: "authorize-and-apply-document-command" },
          new Error("AGENT_GRANT_REVOKED"),
        );
      });
      await env.DOCUMENT_AGENT_WORKFLOW.create({ id: input.runId, params: input });
      await introspector.waitForStatus("errored");
      await expect(
        env.AgentCoordinator.getByName(AGENT_ID).getRun(input.runId),
      ).resolves.toMatchObject({ status: "failed", errorCode: "AGENT_GRANT_REVOKED" });
    } finally {
      await introspector.dispose();
    }
  });

  it("does not reopen or fail a run after cancellation has started", async () => {
    const input = params(
      "88888888-8888-4888-8888-888888888888",
      "99999999-9999-4999-8999-999999999999",
    );
    await createCoordinatorRun(input);
    const coordinator = env.AgentCoordinator.getByName(AGENT_ID);
    await coordinator.transitionRun({
      transitionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      runId: input.runId,
      status: "running",
    });
    await coordinator.transitionRun({
      transitionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      runId: input.runId,
      status: "cancelling",
    });

    const introspector = await introspectWorkflowInstance(env.DOCUMENT_AGENT_WORKFLOW, input.runId);
    try {
      await introspector.modify(async (modifier) => {
        await modifier.disableRetryDelays();
        await modifier.mockStepResult(
          { name: "authorize-and-apply-document-command" },
          { shouldNotBeObserved: true },
        );
      });
      await env.DOCUMENT_AGENT_WORKFLOW.create({ id: input.runId, params: input });
      await introspector.waitForStatus("errored");
      await expect(coordinator.getRun(input.runId)).resolves.toMatchObject({
        status: "cancelling",
        errorCode: null,
      });
      await coordinator.transitionRun({
        transitionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        runId: input.runId,
        status: "cancelled",
      });
    } finally {
      await introspector.dispose();
    }
  });
});
