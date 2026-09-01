import { describe, expect, it } from "vitest";

import {
  agentRunCreateFingerprint,
  agentRunCreateSchema,
  canTransitionAgentRun,
  isTerminalAgentRunStatus,
} from "../src/agent-run/protocol";

const input = {
  runId: "11111111-1111-4111-8111-111111111111",
  idempotencyKey: "22222222-2222-4222-8222-222222222222",
  agentId: "agent-1",
  workflowId: "33333333-3333-4333-8333-333333333333",
  organizationId: "organization-1",
  projectId: "44444444-4444-4444-8444-444444444444",
  documentId: "55555555-5555-4555-8555-555555555555",
  kind: "document.edit" as const,
};

describe("agent run protocol", () => {
  it("accepts only scoped document-edit runs and excludes the retry key from the fingerprint", () => {
    expect(agentRunCreateSchema.parse(input)).toEqual(input);
    expect(
      agentRunCreateFingerprint({
        ...input,
        idempotencyKey: "66666666-6666-4666-8666-666666666666",
      }),
    ).toBe(agentRunCreateFingerprint(input));
    expect(agentRunCreateSchema.safeParse({ ...input, projectId: "not-a-uuid" }).success).toBe(
      false,
    );
  });

  it("allows cancellation and retry-oriented waiting without reopening terminal runs", () => {
    expect(canTransitionAgentRun("queued", "running")).toBe(true);
    expect(canTransitionAgentRun("running", "waiting")).toBe(true);
    expect(canTransitionAgentRun("waiting", "running")).toBe(true);
    expect(canTransitionAgentRun("running", "cancelling")).toBe(true);
    expect(canTransitionAgentRun("cancelling", "cancelled")).toBe(true);
    expect(canTransitionAgentRun("succeeded", "running")).toBe(false);
    expect(isTerminalAgentRunStatus("failed")).toBe(true);
    expect(isTerminalAgentRunStatus("waiting")).toBe(false);
  });
});
