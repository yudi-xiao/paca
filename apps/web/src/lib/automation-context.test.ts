import { describe, expect, it } from "vitest";
import type { AutomationNode } from "./automation-api";
import {
	workerNodeRequiresTask,
	workerTriggerHasNoTask,
} from "./automation-context";
import { normalizedAutomationCron } from "./automation-cron";

const node = (
	kind: AutomationNode["kind"],
	type: string,
	config: Record<string, unknown> = {},
): AutomationNode => ({
	id: "node",
	automation_id: "graph",
	kind,
	type,
	config,
	pos_x: 0,
	pos_y: 0,
});
describe("Worker Automation editor context", () => {
	it("accepts task-free waits, Sprint conditions and explicit targets", () => {
		expect(
			workerNodeRequiresTask(node("action", "wait", { wait_minutes: 1 })),
		).toBe(false);
		expect(workerNodeRequiresTask(node("action", "update_task"))).toBe(true);
		expect(
			workerNodeRequiresTask(
				node("action", "update_task", {
					target: { kind: "other", other_task_id: "task" },
				}),
			),
		).toBe(false);
		expect(
			workerNodeRequiresTask(
				node("condition", "condition", {
					branches: [{ tree: { field: "sprint_name" } }, { tree: null }],
				}),
			),
		).toBe(false);
		expect(
			workerNodeRequiresTask(
				node("condition", "condition", {
					branches: [{ tree: { field: "sprint_id" } }],
				}),
			),
		).toBe(true);
		expect(
			workerNodeRequiresTask(
				node("condition", "condition", {
					branches: [
						{
							tree: {
								field: "tags",
								target: { kind: "other", other_task_id: "task" },
							},
						},
					],
				}),
			),
		).toBe(false);
	});
	it("keeps Sprint events task-free and schedules bound to their configured target", () => {
		for (const type of [
			"sprint_created",
			"sprint_started",
			"sprint_completed",
			"sprint_deleted",
		])
			expect(workerTriggerHasNoTask(node("trigger", type))).toBe(true);
		expect(workerTriggerHasNoTask(node("trigger", "cron"))).toBe(true);
		expect(
			workerTriggerHasNoTask(
				node("trigger", "cron", { target_task_id: "task" }),
			),
		).toBe(false);
		expect(workerTriggerHasNoTask(node("trigger", "task_created"))).toBe(false);
	});
	it("normalizes valid five-field schedules and rejects impossible or unsupported expressions", () => {
		expect(normalizedAutomationCron("  */15   * * * *  ")).toBe("*/15 * * * *");
		expect(normalizedAutomationCron("0 9 * JAN MON-FRI")).toBe(
			"0 9 * JAN MON-FRI",
		);
		for (const invalid of [
			"",
			"@daily",
			"* * * * * *",
			"61 * * * *",
			"0 0 31 2 *",
			"H * * * *",
			"0 0 L * *",
			"*/0 * * * *",
		])
			expect(normalizedAutomationCron(invalid)).toBeNull();
	});
});
