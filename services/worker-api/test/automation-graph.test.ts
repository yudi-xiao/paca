import { describe, expect, it } from "vitest";

import {
  AutomationGraphError,
  automationGraphErrorCodes,
  type GraphEdge,
  type GraphNode,
  normalizeAutomationName,
  validateAutomationActivation,
  validateAutomationEdge,
  validateAutomationNode,
} from "../src/automation/graph";

const automationId = crypto.randomUUID();
const trigger: GraphNode = {
  id: crypto.randomUUID(),
  automationId,
  kind: "trigger",
  type: "task_created",
  config: {},
};
const condition: GraphNode = {
  id: crypto.randomUUID(),
  automationId,
  kind: "condition",
  type: "condition",
  config: {
    branches: [{ handle: "review", tree: { field: "importance", operator: "equals", value: 1 } }],
  },
};
const action: GraphNode = {
  id: crypto.randomUUID(),
  automationId,
  kind: "action",
  type: "update_task",
  config: {},
};

function code(operation: () => void): string | undefined {
  try {
    operation();
  } catch (error) {
    if (error instanceof AutomationGraphError) return error.code;
    throw error;
  }
  return undefined;
}

describe("Automation graph invariants", () => {
  it("normalizes names and rejects unsupported or non-finite nodes", () => {
    expect(normalizeAutomationName("  Review tasks  ")).toBe("Review tasks");
    expect(code(() => normalizeAutomationName("  "))).toBe(automationGraphErrorCodes.nameInvalid);
    expect(
      code(() =>
        validateAutomationNode({
          kind: "action",
          type: "uninstalled.plugin.action",
          config: {},
          posX: 0,
          posY: 0,
        }),
      ),
    ).toBe(automationGraphErrorCodes.nodeInvalidType);
    expect(
      code(() =>
        validateAutomationNode({
          kind: "action",
          type: "update_task",
          config: {},
          posX: Number.POSITIVE_INFINITY,
          posY: 0,
        }),
      ),
    ).toBe(automationGraphErrorCodes.nodePositionInvalid);
  });

  it("rejects cross-automation edges, edges into triggers and invalid handles", () => {
    const foreignAction = { ...action, id: crypto.randomUUID(), automationId: crypto.randomUUID() };
    const nodes = [trigger, condition, action, foreignAction];
    expect(
      code(() =>
        validateAutomationEdge(nodes, [], {
          sourceNodeId: trigger.id,
          sourceHandle: null,
          targetNodeId: foreignAction.id,
        }),
      ),
    ).toBe(automationGraphErrorCodes.edgeCrossAutomation);
    expect(
      code(() =>
        validateAutomationEdge(nodes, [], {
          sourceNodeId: action.id,
          sourceHandle: null,
          targetNodeId: trigger.id,
        }),
      ),
    ).toBe(automationGraphErrorCodes.edgeIntoTrigger);
    expect(
      code(() =>
        validateAutomationEdge(nodes, [], {
          sourceNodeId: condition.id,
          sourceHandle: null,
          targetNodeId: action.id,
        }),
      ),
    ).toBe(automationGraphErrorCodes.edgeHandleRequired);
    expect(
      code(() =>
        validateAutomationEdge(nodes, [], {
          sourceNodeId: condition.id,
          sourceHandle: "missing",
          targetNodeId: action.id,
        }),
      ),
    ).toBe(automationGraphErrorCodes.edgeHandleNotAllowed);
  });

  it("rejects duplicate paths and cycles across an otherwise valid graph", () => {
    const nodes = [trigger, condition, action];
    const first: GraphEdge = {
      sourceNodeId: trigger.id,
      sourceHandle: null,
      targetNodeId: condition.id,
    };
    const second: GraphEdge = {
      sourceNodeId: condition.id,
      sourceHandle: "review",
      targetNodeId: action.id,
    };
    validateAutomationEdge(nodes, [], first);
    validateAutomationEdge(nodes, [first], second);
    expect(code(() => validateAutomationEdge(nodes, [first], first))).toBe(
      automationGraphErrorCodes.edgeDuplicate,
    );
    expect(
      code(() =>
        validateAutomationEdge(nodes, [first, second], {
          sourceNodeId: action.id,
          sourceHandle: null,
          targetNodeId: condition.id,
        }),
      ),
    ).toBe(automationGraphErrorCodes.edgeCycle);
    validateAutomationActivation(nodes, [first, second]);
  });

  it("requires a reachable action before activation", () => {
    expect(code(() => validateAutomationActivation([action], []))).toBe(
      automationGraphErrorCodes.activateNoTrigger,
    );
    expect(code(() => validateAutomationActivation([trigger], []))).toBe(
      automationGraphErrorCodes.activateNoAction,
    );
    expect(code(() => validateAutomationActivation([trigger, action], []))).toBe(
      automationGraphErrorCodes.activateUnreachableAction,
    );
  });
});
