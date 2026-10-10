/// <reference types="@cloudflare/vitest-plugin/types" />
import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AutomationRunSnapshot } from "../../src/automation/run-protocol";

const projectId = "11111111-1111-4111-8111-111111111111";
const triggerId = "22222222-2222-4222-8222-222222222222";
const waitId = "33333333-3333-4333-8333-333333333333";
const conditionId = "44444444-4444-4444-8444-444444444444";
const actionId = "55555555-5555-4555-8555-555555555555";
const taskId = "66666666-6666-4666-8666-666666666666";
const sprintId = "77777777-7777-4777-8777-777777777777";
function snapshot(sprint: boolean): AutomationRunSnapshot {
  return {
    version: 1,
    projectId,
    event: {
      id: crypto.randomUUID(),
      type: sprint ? "sprint_deleted" : "cron",
      taskId: null,
      ...(sprint
        ? {
            sprintSnapshot: {
              id: crypto.randomUUID(),
              projectId,
              name: "Release",
              status: "completed" as const,
              goal: null,
              startDate: null,
              endDate: null,
            },
          }
        : {}),
      payload: {},
    },
    nodes: [
      {
        id: triggerId,
        kind: "trigger",
        type: sprint ? "sprint_deleted" : "cron",
        config: sprint ? {} : { cron_expression: "* * * * *" },
      },
      { id: waitId, kind: "action", type: "wait", config: { wait_minutes: 1 } },
      {
        id: conditionId,
        kind: "condition",
        type: "condition",
        config: {
          branches: [
            {
              handle: "match",
              tree: { field: "sprint_status", operator: "equals", value: "completed" },
            },
          ],
        },
      },
      {
        id: actionId,
        kind: "action",
        type: "update_task",
        config: { update: { tags: ["release"] }, target: { kind: "other", other_task_id: taskId } },
      },
    ],
    edges: [
      { sourceNodeId: triggerId, sourceHandle: null, targetNodeId: waitId },
      ...(sprint
        ? [
            { sourceNodeId: waitId, sourceHandle: null, targetNodeId: conditionId },
            { sourceNodeId: conditionId, sourceHandle: "match", targetNodeId: actionId },
          ]
        : [{ sourceNodeId: waitId, sourceHandle: null, targetNodeId: actionId }]),
    ],
  };
}
describe("Automation Workflow runtime", () => {
  it.each([
    "update_sprint",
    "complete_sprint",
  ] as const)("continues from a durable %s action to the following task action", async (type) => {
    const runId = crypto.randomUUID();
    const input = snapshot(true);
    input.event.type = "sprint_started";
    if (!input.event.sprintSnapshot) throw new Error("FIXTURE_SPRINT_MISSING");
    input.event.sprintSnapshot.id = sprintId;
    input.event.sprintSnapshot.status = "active";
    input.nodes = input.nodes.filter((node) => node.id !== conditionId);
    input.nodes.push({
      id: conditionId,
      kind: "action",
      type,
      config: type === "update_sprint" ? { sprint_update: { goal: null } } : {},
    });
    input.edges = [
      { sourceNodeId: triggerId, sourceHandle: null, targetNodeId: waitId },
      { sourceNodeId: waitId, sourceHandle: null, targetNodeId: conditionId },
      { sourceNodeId: conditionId, sourceHandle: null, targetNodeId: actionId },
    ];
    const result = { sprint_id: sprintId, applied: true, moved_task_count: 0, changes: [] };
    const introspector = await introspectWorkflowInstance(env.AUTOMATION_WORKFLOW, runId);
    try {
      await introspector.modify(async (modifier) => {
        await modifier.disableSleeps();
        await modifier.disableRetryDelays();
        await modifier.mockStepResult(
          { name: "load-run-snapshot" },
          JSON.stringify({ status: "running", triggerNodeId: triggerId, snapshot: input }),
        );
        await modifier.mockStepResult({ name: `resolve-sprint-${conditionId}` }, sprintId);
        await modifier.mockStepResult({ name: `apply-sprint-${conditionId}` }, result);
        await modifier.mockStepResult({ name: `resolve-update-targets-${actionId}` }, [taskId]);
        for (const name of [
          `record-wait-${waitId}`,
          `update-task-${actionId}-batch-0`,
          `record-update-task-${actionId}`,
          "mark-run-completed",
        ])
          await modifier.mockStepResult({ name }, { recorded: true });
      });
      await env.AUTOMATION_WORKFLOW.create({ id: runId, params: { runId } });
      await introspector.waitForStatus("complete");
      await expect(introspector.getOutput()).resolves.toEqual({ status: "completed" });
      await expect(
        introspector.waitForStepResult({ name: `apply-sprint-${conditionId}` }),
      ).resolves.toEqual(result);
      await expect(
        introspector.waitForStepResult({ name: `resolve-update-targets-${actionId}` }),
      ).resolves.toEqual([taskId]);
    } finally {
      await introspector.dispose();
    }
  });
  it("rejects a deleted Sprint snapshot before resolving or applying an action", async () => {
    const runId = crypto.randomUUID();
    const input = snapshot(true);
    const action = input.nodes.find((node) => node.id === actionId);
    if (!action) throw new Error("FIXTURE_ACTION_MISSING");
    action.type = "complete_sprint";
    action.config = {};
    input.edges = [{ sourceNodeId: triggerId, sourceHandle: null, targetNodeId: actionId }];
    const introspector = await introspectWorkflowInstance(env.AUTOMATION_WORKFLOW, runId);
    try {
      await introspector.modify(async (modifier) => {
        await modifier.disableRetryDelays();
        await modifier.mockStepResult(
          { name: "load-run-snapshot" },
          JSON.stringify({ status: "running", triggerNodeId: triggerId, snapshot: input }),
        );
        await modifier.mockStepResult({ name: "mark-run-failed" }, { recorded: true });
      });
      await env.AUTOMATION_WORKFLOW.create({ id: runId, params: { runId } });
      await introspector.waitForStatus("errored");
      await expect(introspector.waitForStepResult({ name: "mark-run-failed" })).resolves.toEqual({
        recorded: true,
      });
    } finally {
      await introspector.dispose();
    }
  });
  it.each([
    false,
    true,
  ])("runs a task-free schedule/Sprint path through durable steps (%s)", async (sprint) => {
    const runId = crypto.randomUUID();
    const input = snapshot(sprint);
    const introspector = await introspectWorkflowInstance(env.AUTOMATION_WORKFLOW, runId);
    try {
      await introspector.modify(async (modifier) => {
        await modifier.disableSleeps();
        await modifier.disableRetryDelays();
        await modifier.mockStepResult(
          { name: "load-run-snapshot" },
          JSON.stringify({ status: "running", triggerNodeId: triggerId, snapshot: input }),
        );
        for (const name of [
          `record-wait-${waitId}`,
          `record-condition-${conditionId}`,
          `update-task-${actionId}-batch-0`,
          `record-update-task-${actionId}`,
          "mark-run-completed",
        ])
          await modifier.mockStepResult({ name }, { recorded: true });
        await modifier.mockStepResult({ name: `evaluate-condition-${conditionId}` }, "match");
        await modifier.mockStepResult({ name: `resolve-update-targets-${actionId}` }, [taskId]);
      });
      await env.AUTOMATION_WORKFLOW.create({ id: runId, params: { runId } });
      await introspector.waitForStatus("complete");
      await expect(introspector.getOutput()).resolves.toEqual({ status: "completed" });
      await expect(
        introspector.waitForStepResult({ name: `resolve-update-targets-${actionId}` }),
      ).resolves.toEqual([taskId]);
      if (sprint)
        await expect(
          introspector.waitForStepResult({ name: `evaluate-condition-${conditionId}` }),
        ).resolves.toBe("match");
    } finally {
      await introspector.dispose();
    }
  });
  it("fails closed when a stored task-free run tries to update self", async () => {
    const runId = crypto.randomUUID();
    const input = snapshot(false);
    const action = input.nodes.find((node) => node.id === actionId);
    if (!action) throw new Error("FIXTURE_ACTION_MISSING");
    action.config = { update: { tags: ["unsafe"] } };
    const introspector = await introspectWorkflowInstance(env.AUTOMATION_WORKFLOW, runId);
    try {
      await introspector.modify(async (modifier) => {
        await modifier.disableSleeps();
        await modifier.mockStepResult(
          { name: "load-run-snapshot" },
          JSON.stringify({ status: "running", triggerNodeId: triggerId, snapshot: input }),
        );
        await modifier.mockStepResult({ name: `record-wait-${waitId}` }, { recorded: true });
        await modifier.mockStepResult({ name: "mark-run-failed" }, { recorded: true });
      });
      await env.AUTOMATION_WORKFLOW.create({ id: runId, params: { runId } });
      await introspector.waitForStatus("errored");
      await expect(introspector.waitForStepResult({ name: "mark-run-failed" })).resolves.toEqual({
        recorded: true,
      });
    } finally {
      await introspector.dispose();
    }
  });
});
