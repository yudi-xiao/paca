import type { AgentSession, CapabilityConstraints } from "@better-auth/agent-auth";
import { describe, expect, it } from "vitest";

import {
  areKnownPacaCapabilities,
  evaluateAgentCapability,
  hasValidCapabilityConstraints,
  pacaCapabilities,
} from "../src/agent-auth/capabilities";

const NOW = new Date("2026-08-28T07:00:00.000Z");
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const DOCUMENT_ID = "44444444-4444-4444-8444-444444444444";

function session(
  capability: string,
  constraints: CapabilityConstraints | null,
  status = "active",
): AgentSession {
  return {
    type: "delegated",
    agentId: "agent-1",
    userId: "user-1",
    agent: {
      id: "agent-1",
      name: "Test agent",
      mode: "delegated",
      capabilityGrants: [{ capability, constraints, grantedBy: "user-1", status }],
      hostId: "host-1",
      createdAt: NOW,
      activatedAt: NOW,
      metadata: null,
    },
    host: { id: "host-1", userId: "user-1", status: "active" },
    user: { id: "user-1", name: "User", email: "user@paca.test" },
  };
}

const taskWriteConstraints = {
  organizationId: "paca-default",
  projectId: PROJECT_ID,
  taskId: { in: [TASK_ID] },
  field: { in: ["title", "statusId"] },
  operationMode: "collaborate",
  validUntil: "2026-08-28T07:10:00.000Z",
} satisfies CapabilityConstraints;

describe("Paca Agent Auth capability contract", () => {
  it("publishes the reviewed domain capability catalog", () => {
    expect(pacaCapabilities.map((capability) => capability.name)).toEqual([
      "project.read",
      "task.read",
      "task.write",
      "task.create",
      "document.read",
      "document.edit",
      "environment.connect",
      "workflow.execute",
    ]);
    expect(pacaCapabilities.every((capability) => capability.grantTTL === 900)).toBe(true);
    expect(areKnownPacaCapabilities(["project.read", "document.edit"])).toBe(true);
    expect(areKnownPacaCapabilities(["project.read", "admin.everything"])).toBe(false);
  });

  it("accepts a matching active, time-bounded task grant", () => {
    expect(
      evaluateAgentCapability(
        session("task.write", taskWriteConstraints),
        "task.write",
        {
          organizationId: "paca-default",
          projectId: PROJECT_ID,
          taskId: TASK_ID,
          field: "title",
          operationMode: "collaborate",
        },
        NOW,
      ),
    ).toEqual({ allowed: true });
  });

  it("rejects wrong project, task, field, and operation constraints", () => {
    const agentSession = session("task.write", taskWriteConstraints);
    for (const context of [
      {
        organizationId: "paca-default",
        projectId: "33333333-3333-4333-8333-333333333333",
        taskId: TASK_ID,
        field: "title",
        operationMode: "collaborate",
      },
      {
        organizationId: "paca-default",
        projectId: PROJECT_ID,
        taskId: "44444444-4444-4444-8444-444444444444",
        field: "title",
        operationMode: "collaborate",
      },
      {
        organizationId: "paca-default",
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        field: "description",
        operationMode: "collaborate",
      },
      {
        organizationId: "paca-default",
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        field: "title",
        operationMode: "exclusive",
      },
    ]) {
      expect(evaluateAgentCapability(agentSession, "task.write", context, NOW)).toEqual({
        allowed: false,
        code: "AGENT_GRANT_CONSTRAINT_MISMATCH",
      });
    }
  });

  it("rejects expired, inactive, missing, and malformed grants", () => {
    expect(
      evaluateAgentCapability(
        session("task.write", { ...taskWriteConstraints, validUntil: NOW.toISOString() }),
        "task.write",
        {
          organizationId: "paca-default",
          projectId: PROJECT_ID,
          taskId: TASK_ID,
          field: "title",
          operationMode: "collaborate",
        },
        NOW,
      ),
    ).toEqual({ allowed: false, code: "AGENT_GRANT_EXPIRED" });

    expect(
      evaluateAgentCapability(
        session("task.write", taskWriteConstraints, "revoked"),
        "task.write",
        {
          organizationId: "paca-default",
          projectId: PROJECT_ID,
        },
        NOW,
      ),
    ).toEqual({ allowed: false, code: "AGENT_CAPABILITY_NOT_GRANTED" });

    expect(
      evaluateAgentCapability(
        session("task.write", null),
        "task.write",
        {
          organizationId: "paca-default",
          projectId: PROJECT_ID,
        },
        NOW,
      ),
    ).toEqual({ allowed: false, code: "AGENT_GRANT_CONSTRAINTS_INVALID" });

    expect(
      hasValidCapabilityConstraints("task.write", {
        organizationId: "paca-default",
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        field: "title",
        operationMode: "collaborate",
      }),
    ).toBe(false);
  });

  it("binds exclusive document lease commands to action and operation mode constraints", () => {
    const constraints = {
      organizationId: "paca-default",
      projectId: PROJECT_ID,
      documentId: DOCUMENT_ID,
      field: "block.content",
      operationMode: "exclusive",
      action: { in: ["acquire_lease", "renew_lease", "apply", "release_lease"] },
      validUntil: "2026-08-28T07:10:00.000Z",
    } satisfies CapabilityConstraints;
    const agentSession = session("document.edit", constraints);

    expect(
      evaluateAgentCapability(
        agentSession,
        "document.edit",
        {
          organizationId: "paca-default",
          projectId: PROJECT_ID,
          documentId: DOCUMENT_ID,
          field: "block.content",
          operationMode: "exclusive",
          action: "acquire_lease",
        },
        NOW,
      ),
    ).toEqual({ allowed: true });
    expect(
      evaluateAgentCapability(
        agentSession,
        "document.edit",
        {
          organizationId: "paca-default",
          projectId: PROJECT_ID,
          documentId: DOCUMENT_ID,
          field: "block.content",
          operationMode: "collaborate",
          action: "apply",
        },
        NOW,
      ),
    ).toEqual({ allowed: false, code: "AGENT_GRANT_CONSTRAINT_MISMATCH" });
    expect(
      hasValidCapabilityConstraints("document.edit", {
        organizationId: "paca-default",
        projectId: PROJECT_ID,
        documentId: DOCUMENT_ID,
        field: "block.content",
        operationMode: "exclusive",
        validUntil: "2026-08-28T07:10:00.000Z",
      }),
    ).toBe(false);
  });

  it("evaluates every active Grant when one capability has separate action scopes", () => {
    const collaborate = {
      organizationId: "paca-default",
      projectId: PROJECT_ID,
      documentId: DOCUMENT_ID,
      field: "block.content",
      operationMode: "collaborate",
      action: "apply",
      validUntil: "2026-08-28T07:10:00.000Z",
    } satisfies CapabilityConstraints;
    const exclusive = {
      ...collaborate,
      operationMode: "exclusive",
      action: "acquire_lease",
    } satisfies CapabilityConstraints;
    const agentSession = session("document.edit", collaborate);
    agentSession.agent.capabilityGrants.push({
      capability: "document.edit",
      constraints: exclusive,
      grantedBy: "user-1",
      status: "active",
    });

    expect(
      evaluateAgentCapability(
        agentSession,
        "document.edit",
        {
          organizationId: "paca-default",
          projectId: PROJECT_ID,
          documentId: DOCUMENT_ID,
          field: "block.content",
          operationMode: "exclusive",
          action: "acquire_lease",
        },
        NOW,
      ),
    ).toEqual({ allowed: true });
  });
});
