import type {
	ActionConfig,
	AutomationNode,
	ConditionConfig,
	TriggerConfig,
} from "./automation-api";

const sprintFields = new Set([
	"sprint_name",
	"sprint_status",
	"sprint_goal",
	"sprint_start_date",
	"sprint_end_date",
]);
export function workerNodeRequiresTask(node: AutomationNode): boolean {
	if (node.kind === "action")
		return (
			node.type === "update_task" &&
			(node.config as ActionConfig).target?.kind !== "other"
		);
	if (node.kind === "condition")
		return ((node.config as unknown as ConditionConfig).branches ?? []).some(
			(branch) =>
				branch.tree &&
				!sprintFields.has(branch.tree.field) &&
				branch.tree.target?.kind !== "other",
		);
	return false;
}
export function workerTriggerHasNoTask(node: AutomationNode): boolean {
	return (
		node.kind === "trigger" &&
		([
			"sprint_created",
			"sprint_started",
			"sprint_completed",
			"sprint_deleted",
		].includes(node.type) ||
			(node.type === "cron" && !(node.config as TriggerConfig).target_task_id))
	);
}

export function workerNodeRequiresSprint(node: AutomationNode): boolean {
	return (
		node.kind === "action" &&
		["update_sprint", "complete_sprint"].includes(node.type)
	);
}
export function workerTriggerHasNoSprint(node: AutomationNode): boolean {
	return (
		node.kind === "trigger" &&
		(node.type === "sprint_deleted" ||
			(node.type === "cron" && !(node.config as TriggerConfig).target_task_id))
	);
}
