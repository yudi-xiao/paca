import { describe, expect, it } from "vitest";

import { orderedReachableNodes, waitMinutes } from "../src/automation/execution-plan";
import type { AutomationRunSnapshot } from "../src/automation/run-protocol";

const triggerId = "11111111-1111-4111-8111-111111111111";
const firstActionId = "22222222-2222-4222-8222-222222222222";
const secondActionId = "33333333-3333-4333-8333-333333333333";
const unrelatedId = "44444444-4444-4444-8444-444444444444";

function snapshot(): AutomationRunSnapshot {
  return {
    version: 1,
    projectId: "55555555-5555-4555-8555-555555555555",
    event: {
      id: "66666666-6666-4666-8666-666666666666",
      type: "task_created",
      taskId: "77777777-7777-4777-8777-777777777777",
      payload: {},
    },
    nodes: [
      { id: triggerId, kind: "trigger", type: "task_created", config: {} },
      { id: firstActionId, kind: "action", type: "wait", config: { wait_minutes: 1 } },
      { id: secondActionId, kind: "action", type: "wait", config: { wait_minutes: 2 } },
      { id: unrelatedId, kind: "trigger", type: "status_changed", config: {} },
    ],
    edges: [
      { sourceNodeId: triggerId, sourceHandle: null, targetNodeId: secondActionId },
      { sourceNodeId: triggerId, sourceHandle: null, targetNodeId: firstActionId },
      { sourceNodeId: firstActionId, sourceHandle: null, targetNodeId: secondActionId },
    ],
  };
}

describe("automation execution plan", () => {
  it("orders only reachable nodes by dependencies, regardless of edge insertion order", () => {
    expect(orderedReachableNodes(snapshot(), triggerId).map((node) => node.id)).toEqual([
      triggerId,
      firstActionId,
      secondActionId,
    ]);
  });

  it("rejects a missing trigger, dangling edge and cycle", () => {
    expect(() => orderedReachableNodes(snapshot(), firstActionId)).toThrow(
      "AUTOMATION_TRIGGER_NODE_INVALID",
    );
    const dangling = snapshot();
    dangling.edges.push({
      sourceNodeId: triggerId,
      sourceHandle: null,
      targetNodeId: "88888888-8888-4888-8888-888888888888",
    });
    expect(() => orderedReachableNodes(dangling, triggerId)).toThrow(
      "AUTOMATION_SNAPSHOT_EDGE_INVALID",
    );
    const cyclic = snapshot();
    cyclic.edges.push({
      sourceNodeId: secondActionId,
      sourceHandle: null,
      targetNodeId: firstActionId,
    });
    expect(() => orderedReachableNodes(cyclic, triggerId)).toThrow("AUTOMATION_SNAPSHOT_CYCLE");
  });

  it("accepts only bounded wait actions and rejects unsupported effects", () => {
    const wait = snapshot().nodes[1];
    if (!wait) throw new Error("AUTOMATION_TEST_NODE_MISSING");
    expect(waitMinutes(wait)).toBe(1);
    expect(waitMinutes({ ...wait, config: { wait_minutes: 10_080 } })).toBe(10_080);
    expect(() => waitMinutes({ ...wait, config: { wait_minutes: 0 } })).toThrow(
      "AUTOMATION_WAIT_CONFIG_INVALID",
    );
    expect(() => waitMinutes({ ...wait, type: "update_task" })).toThrow(
      "AUTOMATION_ACTION_UNSUPPORTED",
    );
  });
});
