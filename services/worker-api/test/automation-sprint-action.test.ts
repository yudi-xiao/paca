import { describe, expect, it } from "vitest";
import { validateRunnableAutomationGraph } from "../src/automation/execution-plan";
import { sprintActionFromNode } from "../src/iteration/automation-config";

const automationId = crypto.randomUUID();
function node(type: string, config: Record<string, unknown>) {
  return { kind: "action" as const, id: crypto.randomUUID(), automationId, type, config };
}
describe("Sprint automation configuration", () => {
  it("preserves explicit clears, converts UTC dates and trims bounded strings", () => {
    expect(
      sprintActionFromNode(
        node("update_sprint", {
          sprint_update: {
            name: " {{sprint.name}} ",
            start_date: "2026-10-10T00:00:00Z",
            end_date: null,
            goal: null,
            status: "active",
          },
        }),
      ),
    ).toEqual({
      type: "update_sprint",
      update: {
        name: "{{sprint.name}}",
        startDate: "2026-10-10",
        endDate: null,
        goal: null,
        status: "active",
      },
    });
    expect(sprintActionFromNode(node("complete_sprint", {}))).toEqual({
      type: "complete_sprint",
      destinationSprintId: null,
    });
  });
  it.each([
    {},
    { sprint_update: {} },
    { sprint_update: { name: " " } },
    { sprint_update: { name: "x".repeat(201) } },
    { sprint_update: { goal: "x".repeat(10001) } },
    { sprint_update: { start_date: "2026-02-30" } },
    { sprint_update: { start_date: "2026-10-20", end_date: "2026-10-10" } },
    { sprint_update: { end_date: "2026-10-10T01:00:00Z" } },
    { sprint_update: { unknown: true } },
    { sprint_update: { status: "running" } },
    { sprint_update: { goal: "ok" }, actor_id: "user" },
  ])("rejects invalid or unbounded update configuration (%j)", (config) => {
    expect(() => sprintActionFromNode(node("update_sprint", config))).toThrow(
      "AUTOMATION_UPDATE_SPRINT_CONFIG_INVALID",
    );
  });
  it.each([
    { move_to_sprint_id: "bad" },
    { move_to_sprint_id: crypto.randomUUID(), project_id: crypto.randomUUID() },
  ])("rejects malformed or cross-scope completion input", (config) =>
    expect(() => sprintActionFromNode(node("complete_sprint", config))).toThrow(
      "AUTOMATION_COMPLETE_SPRINT_CONFIG_INVALID",
    ));
  it("permits Sprint and task context, while rejecting deleted Sprints and task-free schedules", () => {
    for (const type of [
      "sprint_started",
      "sprint_created",
      "sprint_completed",
      "sprint_deleted",
      "task_created",
      "cron",
    ]) {
      const trigger = {
        kind: "trigger" as const,
        id: crypto.randomUUID(),
        automationId,
        type,
        config: type === "cron" ? { cron_expression: "* * * * *" } : {},
      };
      const action = node("complete_sprint", {});
      const validate = () =>
        validateRunnableAutomationGraph(
          [trigger, action],
          [{ sourceNodeId: trigger.id, targetNodeId: action.id, sourceHandle: null }],
        );
      if (type === "cron" || type === "sprint_deleted")
        expect(validate).toThrow("AUTOMATION_EDGE_REQUIRES_TARGET_SPRINT");
      else expect(validate).not.toThrow();
    }
  });
});
