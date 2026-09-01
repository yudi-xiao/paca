import type { AgentSession, CapabilityConstraints } from "@better-auth/agent-auth";
import { describe, expect, it, vi } from "vitest";

import { DOCUMENT_AGENT_WORKFLOW_ID } from "../src/agent-run/document-workflow-protocol";
import type { AgentRunRecord } from "../src/agent-run/protocol";
import { agentRunRuntime } from "../src/agent-run/runtime";
import type { AppBindings } from "../src/bindings";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";

function session(): AgentSession {
  const constraints: CapabilityConstraints = {
    organizationId: "paca-default",
    projectId: PROJECT_ID,
    workflowId: DOCUMENT_AGENT_WORKFLOW_ID,
    operationMode: "execute",
    validUntil: "2099-01-01T00:00:00.000Z",
  };
  return {
    type: "delegated",
    agentId: "agent-1",
    userId: "user-1",
    agent: {
      id: "agent-1",
      name: "Agent",
      mode: "delegated",
      capabilityGrants: [
        { capability: "workflow.execute", constraints, grantedBy: "user-1", status: "active" },
      ],
      hostId: "host-1",
      createdAt: new Date(),
      activatedAt: new Date(),
      metadata: null,
    },
    host: { id: "host-1", userId: "user-1", status: "active" },
    user: { id: "user-1", name: "User", email: "user@paca.test" },
  };
}

function run(status: AgentRunRecord["status"], version: number): AgentRunRecord {
  return {
    runId: RUN_ID,
    idempotencyKey: "33333333-3333-4333-8333-333333333333",
    agentId: "agent-1",
    workflowId: DOCUMENT_AGENT_WORKFLOW_ID,
    organizationId: "paca-default",
    projectId: PROJECT_ID,
    documentId: "44444444-4444-4444-8444-444444444444",
    kind: "document.edit",
    status,
    version,
    createdAt: 1,
    updatedAt: version,
    finishedAt: status === "cancelled" ? version : null,
    errorCode: null,
  };
}

describe("Agent run cancellation", () => {
  it("terminates future Workflow steps but does not request rollback of an applied CRDT write", async () => {
    const terminate = vi.fn(async () => undefined);
    const transitionRun = vi
      .fn()
      .mockResolvedValueOnce({ success: true, duplicate: false, run: run("cancelling", 3) })
      .mockResolvedValueOnce({ success: true, duplicate: false, run: run("cancelled", 4) });
    const coordinator = {
      getRun: vi.fn(async () => run("running", 2)),
      transitionRun,
    };
    const env = {
      AgentCoordinator: { getByName: () => coordinator },
      DOCUMENT_AGENT_WORKFLOW: {
        get: vi.fn(async () => ({ terminate })),
      },
    } as unknown as AppBindings;

    await expect(
      agentRunRuntime.cancelRun(env, session(), PROJECT_ID, RUN_ID),
    ).resolves.toMatchObject({ status: "cancelled", version: 4 });
    expect(transitionRun).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ runId: RUN_ID, status: "cancelling" }),
    );
    expect(terminate).toHaveBeenCalledWith();
    expect(transitionRun).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ runId: RUN_ID, status: "cancelled" }),
    );
  });
});
