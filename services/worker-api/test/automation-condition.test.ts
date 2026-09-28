import { describe, expect, it } from "vitest";

import { conditionConfigFromNode, evaluateConditionLeaf } from "../src/automation/condition";
import type { Task } from "../src/task/service";

const taskId = "11111111-1111-4111-8111-111111111111";
const sprintId = "22222222-2222-4222-8222-222222222222";
const memberId = "33333333-3333-4333-8333-333333333333";

function task(): Task {
  return {
    id: taskId,
    projectId: "44444444-4444-4444-8444-444444444444",
    taskNumber: 1,
    taskTypeId: null,
    statusId: null,
    sprintId,
    parentTaskId: null,
    title: "Review release",
    description: null,
    importance: 5,
    storyPoints: 3,
    assigneeIds: [memberId],
    reporterId: null,
    customFields: { release: "v2", score: 8 },
    startDate: null,
    dueDate: "2026-09-30",
    tags: ["urgent"],
    viewPosition: null,
    viewGroupKey: null,
    createdAt: new Date("2026-09-28T00:00:00Z"),
    updatedAt: new Date("2026-09-28T00:00:00Z"),
  };
}

function condition(config: Record<string, unknown>) {
  return { kind: "condition" as const, type: "condition", config };
}

describe("automation condition", () => {
  it("validates ordered branch handles, operators, target shape and comparison values", () => {
    const valid = condition({
      branches: [
        { handle: "urgent", tree: { field: "tags", operator: "contains", value: "urgent" } },
        { handle: "fallback", tree: null },
      ],
    });
    expect(conditionConfigFromNode(valid).branches).toHaveLength(2);
    expect(conditionConfigFromNode(condition({ branches: [] })).branches).toHaveLength(0);
    expect(() =>
      conditionConfigFromNode(condition({ branches: [{ handle: "else", tree: null }] })),
    ).toThrow("AUTOMATION_CONDITION_CONFIG_INVALID");
    expect(() =>
      conditionConfigFromNode(
        condition({
          branches: [
            { handle: "a", tree: null },
            { handle: "a", tree: null },
          ],
        }),
      ),
    ).toThrow("AUTOMATION_CONDITION_CONFIG_INVALID");
    expect(() =>
      conditionConfigFromNode(
        condition({
          branches: [{ handle: "a", tree: { field: "tags", operator: "equals", value: "x" } }],
        }),
      ),
    ).toThrow("AUTOMATION_CONDITION_CONFIG_INVALID");
    expect(() =>
      conditionConfigFromNode(
        condition({
          branches: [
            { handle: "a", tree: { field: "importance", operator: "greater_than", value: "bad" } },
          ],
        }),
      ),
    ).toThrow("AUTOMATION_CONDITION_CONFIG_INVALID");
    expect(() =>
      conditionConfigFromNode(
        condition({
          branches: [
            {
              handle: "a",
              tree: { field: "title", operator: "contains", value: "x", target: { kind: "other" } },
            },
          ],
        }),
      ),
    ).toThrow("AUTOMATION_CONDITION_CONFIG_INVALID");
  });

  it("compares task scalars, sets, custom fields and RFC3339 dates", () => {
    const current = task();
    expect(
      evaluateConditionLeaf(
        { field: "importance", operator: "greater_than", value: "4" },
        current,
        null,
      ),
    ).toBe(true);
    expect(
      evaluateConditionLeaf(
        { field: "story_points", operator: "less_than", value: "4" },
        current,
        null,
      ),
    ).toBe(true);
    expect(
      evaluateConditionLeaf(
        { field: "title", operator: "contains", value: "release" },
        current,
        null,
      ),
    ).toBe(true);
    expect(
      evaluateConditionLeaf(
        { field: "assignee_ids", operator: "contains", value: memberId },
        current,
        null,
      ),
    ).toBe(true);
    expect(
      evaluateConditionLeaf(
        { field: "tags", operator: "not_equals", value: "blocked" },
        current,
        null,
      ),
    ).toBe(true);
    expect(
      evaluateConditionLeaf(
        { field: "custom_field", field_key: "score", operator: "greater_than", value: "7" },
        current,
        null,
      ),
    ).toBe(true);
    expect(
      evaluateConditionLeaf(
        { field: "custom_field", field_key: "missing", operator: "is_empty" },
        current,
        null,
      ),
    ).toBe(true);
    expect(
      evaluateConditionLeaf(
        { field: "custom_field", field_key: "missing", operator: "not_equals", value: "x" },
        current,
        null,
      ),
    ).toBe(false);
    expect(
      evaluateConditionLeaf(
        { field: "due_date", operator: "equals", value: "2026-09-30T00:00:00Z" },
        current,
        null,
      ),
    ).toBe(true);
    expect(
      evaluateConditionLeaf({ field: "start_date", operator: "is_empty" }, current, null),
    ).toBe(true);
    expect(
      evaluateConditionLeaf(
        { field: "start_date", operator: "not_equals", value: "2026-09-30T00:00:00Z" },
        current,
        null,
      ),
    ).toBe(false);
    expect(
      evaluateConditionLeaf(
        { field: "story_points", operator: "not_equals", value: "2" },
        { ...current, storyPoints: null },
        null,
      ),
    ).toBe(false);
  });

  it("evaluates sprint fields against the current sprint, not a task field", () => {
    const sprint = {
      name: "September",
      status: "active",
      goal: null,
      startDate: "2026-09-01",
      endDate: "2026-09-30",
    };
    expect(
      evaluateConditionLeaf(
        { field: "sprint_name", operator: "contains", value: "tember" },
        null,
        sprint,
      ),
    ).toBe(true);
    expect(
      evaluateConditionLeaf(
        { field: "sprint_status", operator: "equals", value: "active" },
        task(),
        sprint,
      ),
    ).toBe(true);
    expect(
      evaluateConditionLeaf(
        { field: "sprint_end_date", operator: "greater_than", value: "2026-09-29T00:00:00Z" },
        task(),
        sprint,
      ),
    ).toBe(true);
    expect(
      evaluateConditionLeaf({ field: "sprint_name", operator: "is_empty" }, task(), null),
    ).toBe(false);
  });
});
