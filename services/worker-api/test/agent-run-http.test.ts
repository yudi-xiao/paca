import type { AgentSession, CapabilityConstraints } from "@better-auth/agent-auth";
import { describe, expect, it, vi } from "vitest";
import {
  DOCUMENT_AGENT_WORKFLOW_ID,
  type DocumentAgentWorkflowStart,
} from "../src/agent-run/document-workflow-protocol";
import type { AgentRunRuntime } from "../src/agent-run/runtime";
import { createApp } from "../src/app";
import type { AppBindings } from "../src/bindings";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const VALID_UNTIL = "2099-01-01T00:00:00.000Z";

function session(): AgentSession {
  const workflow: CapabilityConstraints = {
    organizationId: "paca-default",
    projectId: PROJECT_ID,
    workflowId: DOCUMENT_AGENT_WORKFLOW_ID,
    operationMode: "execute",
    validUntil: VALID_UNTIL,
  };
  return {
    type: "delegated",
    agentId: "agent-1",
    userId: "user-1",
    agent: {
      id: "agent-1",
      name: "Workflow Agent",
      mode: "delegated",
      capabilityGrants: [
        {
          capability: "workflow.execute",
          constraints: workflow,
          grantedBy: "user-1",
          status: "active",
        },
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

const input: DocumentAgentWorkflowStart = {
  organizationId: "paca-default",
  documentId: DOCUMENT_ID,
  command: {
    action: "acquire_lease",
    requestId: REQUEST_ID,
    runId: RUN_ID,
    operationMode: "exclusive",
    leaseDurationMs: 10_000,
  },
};

const run = {
  runId: RUN_ID,
  idempotencyKey: REQUEST_ID,
  agentId: "agent-1",
  workflowId: DOCUMENT_AGENT_WORKFLOW_ID,
  organizationId: "paca-default",
  projectId: PROJECT_ID,
  documentId: DOCUMENT_ID,
  kind: "document.edit" as const,
  status: "queued" as const,
  version: 1,
  createdAt: Date.parse("2026-09-01T00:00:00.000Z"),
  updatedAt: Date.parse("2026-09-01T00:00:00.000Z"),
  finishedAt: null,
  errorCode: null,
};

function bindings(): AppBindings {
  return { ENVIRONMENT: "test" } as AppBindings;
}

function runtime(): AgentRunRuntime {
  return {
    startDocumentWorkflow: vi.fn(async () => run),
    getRun: vi.fn(async () => run),
    cancelRun: vi.fn(async () => ({ ...run, status: "cancelled" as const })),
  };
}

describe("Agent run Hono API", () => {
  it("starts and reads a scoped document workflow run", async () => {
    const agentRuns = runtime();
    const app = createApp({ currentAgentSession: async () => session(), agentRuns, log: vi.fn() });
    const base = `/api/v1/agent/projects/${PROJECT_ID}/workflows/${DOCUMENT_AGENT_WORKFLOW_ID}/runs`;
    const start = await app.request(
      base,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
      bindings(),
    );
    expect(start.status).toBe(200);
    await expect(start.json()).resolves.toMatchObject({ data: { id: RUN_ID, status: "queued" } });

    const status = await app.request(`${base}/${RUN_ID}`, {}, bindings());
    expect(status.status).toBe(200);
    expect(agentRuns.getRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      PROJECT_ID,
      RUN_ID,
    );
  });

  it("stops at the Agent Auth boundary when workflow.execute is absent", async () => {
    const agentRuns = runtime();
    const denied = session();
    denied.agent.capabilityGrants = [];
    const app = createApp({ currentAgentSession: async () => denied, agentRuns, log: vi.fn() });
    const response = await app.request(
      `/api/v1/agent/projects/${PROJECT_ID}/workflows/${DOCUMENT_AGENT_WORKFLOW_ID}/runs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
      bindings(),
    );
    expect(response.status).toBe(403);
    expect(agentRuns.startDocumentWorkflow).not.toHaveBeenCalled();
  });

  it("cancels an existing run without promising content rollback", async () => {
    const agentRuns = runtime();
    const app = createApp({ currentAgentSession: async () => session(), agentRuns, log: vi.fn() });
    const response = await app.request(
      `/api/v1/agent/projects/${PROJECT_ID}/workflows/${DOCUMENT_AGENT_WORKFLOW_ID}/runs/${RUN_ID}`,
      { method: "DELETE" },
      bindings(),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { status: "cancelled" } });
  });
});
