import { describe, expect, it } from "vitest";

import {
  matchesTaskTrigger,
  orderedReachableNodes,
  taskUpdateActionFromNode,
  taskUpdateFromNode,
  validateRunnableAutomationGraph,
  waitMinutes,
} from "../src/automation/execution-plan";
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

  it("accepts supported task fields and converts UI dates to task dates", () => {
    const graph = snapshot();
    graph.nodes = graph.nodes.filter((node) => node.id !== unrelatedId);
    const action = graph.nodes.find((node) => node.id === firstActionId);
    if (!action) throw new Error("AUTOMATION_TEST_NODE_MISSING");
    action.type = "update_task";
    action.config = {
      update: {
        task_type_id: graph.projectId,
        status_id: graph.projectId,
        sprint_id: graph.projectId,
        parent_task_id: graph.event.taskId,
        title: "  Review task  ",
        description: [{ type: "paragraph", content: [] }],
        importance: 9,
        assignee_ids: [graph.projectId],
        reporter_id: graph.projectId,
        custom_fields: { release: "v2" },
        start_date: "2026-09-28T00:00:00Z",
        due_date: "2026-10-01",
        tags: ["review"],
      },
    };
    const nodes = graph.nodes.map((node) => ({ ...node, automationId: graph.projectId }));
    expect(() => validateRunnableAutomationGraph(nodes, graph.edges)).not.toThrow();
    expect(taskUpdateFromNode(action)).toEqual({
      taskTypeId: graph.projectId,
      statusId: graph.projectId,
      sprintId: graph.projectId,
      parentTaskId: graph.event.taskId,
      title: "Review task",
      description: [{ type: "paragraph", content: [] }],
      importance: 9,
      storyPoints: undefined,
      assigneeIds: [graph.projectId],
      reporterId: graph.projectId,
      customFieldPatch: { release: "v2" },
      startDate: "2026-09-28",
      dueDate: "2026-10-01",
      tags: ["review"],
    });
    action.config = { update: { tags: ["review"] }, target: { kind: "children" } };
    expect(taskUpdateActionFromNode(action)).toMatchObject({
      target: { kind: "children" },
      update: { tags: ["review"] },
    });
    action.config = { update: { tags: ["review"] }, target: { kind: "other" } };
    expect(() => taskUpdateActionFromNode(action)).toThrow("AUTOMATION_UPDATE_TASK_CONFIG_INVALID");
    action.config = {
      update: { tags: ["review"] },
      target: { kind: "self", other_task_id: graph.event.taskId },
    };
    expect(() => taskUpdateActionFromNode(action)).toThrow("AUTOMATION_UPDATE_TASK_CONFIG_INVALID");
    action.config = { update: { due_date: "2026-02-29T00:00:00Z" } };
    expect(() => taskUpdateFromNode(action)).toThrow("AUTOMATION_UPDATE_TASK_CONFIG_INVALID");
    action.config = { update: { due_date: "2026-10-01T01:00:00Z" } };
    expect(() => taskUpdateFromNode(action)).toThrow("AUTOMATION_UPDATE_TASK_CONFIG_INVALID");
    action.config = { update: { status_id: "not-a-uuid" } };
    expect(() => taskUpdateFromNode(action)).toThrow("AUTOMATION_UPDATE_TASK_CONFIG_INVALID");
    action.config = { update: { description: { type: "paragraph" } } };
    expect(() => taskUpdateFromNode(action)).toThrow("AUTOMATION_UPDATE_TASK_CONFIG_INVALID");
    action.config = { update: { custom_fields: {} } };
    expect(() => taskUpdateFromNode(action)).toThrow("AUTOMATION_UPDATE_TASK_CONFIG_INVALID");
    action.config = { update: { unsupported_field: true } };
    expect(() =>
      validateRunnableAutomationGraph(
        graph.nodes.map((node) => ({ ...node, automationId: graph.projectId })),
        graph.edges,
      ),
    ).toThrow("AUTOMATION_UPDATE_TASK_CONFIG_INVALID");
    action.config = { update: { title: "Review {{task.title}}" } };
    expect(() => taskUpdateFromNode(action)).toThrow("AUTOMATION_UPDATE_TASK_CONFIG_INVALID");
  });

  it("accepts a condition switch with valid handles and rejects unsupported leaves", () => {
    const graph = snapshot();
    graph.nodes = graph.nodes.filter((node) => node.id !== unrelatedId);
    const branch = graph.nodes.find((node) => node.id === firstActionId);
    if (!branch) throw new Error("AUTOMATION_TEST_NODE_MISSING");
    branch.kind = "condition";
    branch.type = "condition";
    branch.config = {
      branches: [
        {
          handle: "priority",
          tree: { field: "importance", operator: "greater_than", value: "4" },
        },
      ],
    };
    graph.edges = [
      { sourceNodeId: triggerId, sourceHandle: null, targetNodeId: firstActionId },
      { sourceNodeId: firstActionId, sourceHandle: "priority", targetNodeId: secondActionId },
    ];
    const runnable = () =>
      validateRunnableAutomationGraph(
        graph.nodes.map((node) => ({ ...node, automationId: graph.projectId })),
        graph.edges,
      );
    expect(runnable).not.toThrow();
    const conditionEdge = graph.edges[1];
    if (!conditionEdge) throw new Error("AUTOMATION_TEST_EDGE_MISSING");
    conditionEdge.sourceHandle = "missing";
    expect(runnable).toThrow("AUTOMATION_EDGE_HANDLE_NOT_ALLOWED");
    conditionEdge.sourceHandle = "priority";
    branch.config = {
      branches: [{ handle: "priority", tree: { field: "tags", operator: "equals", value: "x" } }],
    };
    expect(runnable).toThrow("AUTOMATION_CONDITION_CONFIG_INVALID");
  });

  it("matches scoped status triggers and rejects unsupported trigger configuration", () => {
    const status = { type: "status_changed", config: { status_id: firstActionId } };
    expect(matchesTaskTrigger("status_changed", { status_id: firstActionId }, status)).toBe(true);
    expect(matchesTaskTrigger("status_changed", { status_id: secondActionId }, status)).toBe(false);
    expect(() =>
      matchesTaskTrigger("status_changed", {}, { ...status, config: { status_id: "bad" } }),
    ).toThrow("AUTOMATION_TRIGGER_CONFIG_UNSUPPORTED");
    for (const type of ["assignee_changed", "priority_changed"]) {
      expect(matchesTaskTrigger(type, {}, { type, config: {} })).toBe(true);
      expect(() => matchesTaskTrigger(type, {}, { type, config: { unexpected: true } })).toThrow(
        "AUTOMATION_TRIGGER_CONFIG_UNSUPPORTED",
      );
    }
    const tag = { type: "tag_added", config: { tag: "urgent" } };
    expect(matchesTaskTrigger("tag_added", { added_tags: ["urgent", "review"] }, tag)).toBe(true);
    expect(matchesTaskTrigger("tag_added", { added_tags: ["review"] }, tag)).toBe(false);
    expect(() => matchesTaskTrigger("tag_added", {}, tag)).toThrow(
      "AUTOMATION_EVENT_PAYLOAD_INVALID",
    );
    expect(() =>
      matchesTaskTrigger(
        "tag_added",
        { added_tags: ["urgent"] },
        {
          ...tag,
          config: { tag: "" },
        },
      ),
    ).toThrow("AUTOMATION_TRIGGER_CONFIG_UNSUPPORTED");
    const predecessor = {
      type: "predecessor_done",
      config: {
        target_task_id: firstActionId,
        watched_task_ids: [triggerId, secondActionId],
      },
    };
    expect(
      matchesTaskTrigger("predecessor_done", { watched_task_id: triggerId }, predecessor),
    ).toBe(true);
    expect(
      matchesTaskTrigger("predecessor_done", { watched_task_id: unrelatedId }, predecessor),
    ).toBe(false);
    expect(() => matchesTaskTrigger("predecessor_done", {}, predecessor)).toThrow(
      "AUTOMATION_EVENT_PAYLOAD_INVALID",
    );
    expect(() =>
      matchesTaskTrigger(
        "predecessor_done",
        { watched_task_id: triggerId },
        {
          ...predecessor,
          config: { target_task_id: firstActionId, watched_task_ids: [triggerId, triggerId] },
        },
      ),
    ).toThrow("AUTOMATION_TRIGGER_CONFIG_UNSUPPORTED");
  });
});
