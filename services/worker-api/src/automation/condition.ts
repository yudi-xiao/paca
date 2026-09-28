import * as z from "zod";

import type { Task } from "../task/service";
import { AutomationExecutionError } from "./errors";
import type { SnapshotNode } from "./execution-plan";

const taskFields = [
  "status_id",
  "task_type_id",
  "importance",
  "assignee_ids",
  "tags",
  "custom_field",
  "title",
  "story_points",
  "sprint_id",
  "parent_task_id",
  "reporter_id",
  "start_date",
  "due_date",
] as const;
const sprintFields = [
  "sprint_name",
  "sprint_status",
  "sprint_goal",
  "sprint_start_date",
  "sprint_end_date",
] as const;
const fields = [...taskFields, ...sprintFields] as const;
const operators = [
  "equals",
  "not_equals",
  "contains",
  "greater_than",
  "less_than",
  "is_empty",
  "is_not_empty",
] as const;
const targetKinds = [
  "self",
  "parent",
  "children",
  "blocks",
  "is_blocked_by",
  "relates_to",
  "duplicates",
  "is_duplicated_by",
  "other",
] as const;

export const targetSchema = z
  .object({ kind: z.enum(targetKinds), other_task_id: z.uuid().optional() })
  .strict();
const leafSchema = z
  .object({
    field: z.enum(fields),
    field_key: z.string().trim().min(1).max(100).optional(),
    operator: z.enum(operators),
    value: z.unknown().optional(),
    target: targetSchema.optional(),
    match_mode: z.enum(["any", "all"]).optional(),
  })
  .strict();
const conditionSchema = z
  .object({
    branches: z
      .array(
        z
          .object({
            handle: z
              .string()
              .min(1)
              .max(100)
              .refine((handle) => handle.trim() === handle && handle !== "else"),
            label: z.string().max(200).optional(),
            tree: leafSchema.nullish(),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();

export type ConditionLeaf = z.infer<typeof leafSchema>;
export type ConditionConfig = z.infer<typeof conditionSchema>;
export type ConditionTarget = z.infer<typeof targetSchema>;
export type ConditionSprint = {
  name: string;
  status: string;
  goal: string | null;
  startDate: string | null;
  endDate: string | null;
};

export function isSprintConditionField(field: ConditionLeaf["field"]): boolean {
  return sprintFieldSet.has(field);
}

const operatorByField = {
  status_id: ["equals", "not_equals", "is_empty", "is_not_empty"],
  task_type_id: ["equals", "not_equals", "is_empty", "is_not_empty"],
  importance: ["equals", "not_equals", "greater_than", "less_than"],
  assignee_ids: ["contains", "not_equals", "is_empty", "is_not_empty"],
  tags: ["contains", "not_equals", "is_empty", "is_not_empty"],
  custom_field: ["equals", "not_equals", "is_empty", "is_not_empty", "greater_than", "less_than"],
  title: ["equals", "not_equals", "contains", "is_empty", "is_not_empty"],
  story_points: ["equals", "not_equals", "greater_than", "less_than", "is_empty", "is_not_empty"],
  sprint_id: ["equals", "not_equals", "is_empty", "is_not_empty"],
  parent_task_id: ["equals", "not_equals", "is_empty", "is_not_empty"],
  reporter_id: ["equals", "not_equals", "is_empty", "is_not_empty"],
  start_date: ["equals", "not_equals", "greater_than", "less_than", "is_empty", "is_not_empty"],
  due_date: ["equals", "not_equals", "greater_than", "less_than", "is_empty", "is_not_empty"],
  sprint_name: ["equals", "not_equals", "contains", "is_empty", "is_not_empty"],
  sprint_status: ["equals", "not_equals"],
  sprint_goal: ["equals", "not_equals", "contains", "is_empty", "is_not_empty"],
  sprint_start_date: [
    "equals",
    "not_equals",
    "greater_than",
    "less_than",
    "is_empty",
    "is_not_empty",
  ],
  sprint_end_date: [
    "equals",
    "not_equals",
    "greater_than",
    "less_than",
    "is_empty",
    "is_not_empty",
  ],
} as const satisfies Record<(typeof fields)[number], readonly (typeof operators)[number][]>;

const uuidFields = new Set<string>([
  "status_id",
  "task_type_id",
  "assignee_ids",
  "sprint_id",
  "parent_task_id",
  "reporter_id",
]);
const numericFields = new Set<string>(["importance", "story_points"]);
const dateFields = new Set<string>([
  "start_date",
  "due_date",
  "sprint_start_date",
  "sprint_end_date",
]);
const sprintFieldSet = new Set<string>(sprintFields);

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asDateTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validateLeaf(leaf: ConditionLeaf): void {
  const invalid = () => new AutomationExecutionError("AUTOMATION_CONDITION_CONFIG_INVALID");
  if (!(operatorByField[leaf.field] as readonly string[]).includes(leaf.operator)) throw invalid();
  if (leaf.field === "custom_field" && !leaf.field_key) throw invalid();
  if (leaf.target?.kind === "other" && !leaf.target.other_task_id) throw invalid();
  if (leaf.target?.kind !== "other" && leaf.target?.other_task_id) throw invalid();
  if (sprintFieldSet.has(leaf.field) && leaf.target && leaf.target.kind !== "self") throw invalid();
  if (leaf.operator === "is_empty" || leaf.operator === "is_not_empty") return;
  if (uuidFields.has(leaf.field) && !z.uuid().safeParse(leaf.value).success) throw invalid();
  if (numericFields.has(leaf.field) && asFiniteNumber(leaf.value) === null) throw invalid();
  if (dateFields.has(leaf.field) && asDateTimestamp(leaf.value) === null) throw invalid();
  if (leaf.field === "custom_field") {
    if (
      (leaf.operator === "greater_than" || leaf.operator === "less_than") &&
      asFiniteNumber(leaf.value) === null
    ) {
      throw invalid();
    }
    if (leaf.value === undefined || typeof leaf.value === "object") throw invalid();
    return;
  }
  if (
    !uuidFields.has(leaf.field) &&
    !numericFields.has(leaf.field) &&
    !dateFields.has(leaf.field) &&
    typeof leaf.value !== "string"
  ) {
    throw invalid();
  }
}

export function conditionConfigFromNode(
  node: Pick<SnapshotNode, "kind" | "type" | "config">,
): ConditionConfig {
  if (node.kind !== "condition" || node.type !== "condition") {
    throw new AutomationExecutionError("AUTOMATION_NODE_NOT_EXECUTABLE");
  }
  const parsed = conditionSchema.safeParse(node.config);
  if (!parsed.success) throw new AutomationExecutionError("AUTOMATION_CONDITION_CONFIG_INVALID");
  const seen = new Set<string>();
  for (const branch of parsed.data.branches) {
    if (seen.has(branch.handle)) {
      throw new AutomationExecutionError("AUTOMATION_CONDITION_CONFIG_INVALID");
    }
    seen.add(branch.handle);
    if (branch.tree) validateLeaf(branch.tree);
  }
  return parsed.data;
}

function compareScalar(
  field: unknown,
  operator: ConditionLeaf["operator"],
  value: unknown,
): boolean {
  if (operator === "is_empty") return field === null || field === undefined || field === "";
  if (operator === "is_not_empty") return field !== null && field !== undefined && field !== "";
  if (operator === "contains") return String(field ?? "").includes(String(value));
  if (operator === "greater_than" || operator === "less_than") {
    const left = asFiniteNumber(field);
    const right = asFiniteNumber(value);
    if (left === null || right === null) return false;
    return operator === "greater_than" ? left > right : left < right;
  }
  const same = String(field ?? "") === String(value);
  return operator === "equals" ? same : !same;
}

function compareDate(field: string | null, operator: ConditionLeaf["operator"], value: unknown) {
  if (operator === "is_empty") return field === null;
  if (operator === "is_not_empty") return field !== null;
  const left = field ? Date.parse(`${field}T00:00:00Z`) : null;
  const right = asDateTimestamp(value);
  if (left === null || right === null || !Number.isFinite(left)) return false;
  if (operator === "equals") return left === right;
  if (operator === "not_equals") return left !== right;
  if (operator === "greater_than") return left > right;
  return left < right;
}

export function evaluateConditionLeaf(
  leaf: ConditionLeaf | null | undefined,
  task: Task | null,
  sprint: ConditionSprint | null,
): boolean {
  if (!leaf) return true;
  const { field, operator, value } = leaf;
  if (sprintFieldSet.has(field)) {
    if (!sprint) return false;
    if (field === "sprint_start_date") return compareDate(sprint.startDate, operator, value);
    if (field === "sprint_end_date") return compareDate(sprint.endDate, operator, value);
    const scalar =
      field === "sprint_name"
        ? sprint.name
        : field === "sprint_status"
          ? sprint.status
          : sprint.goal;
    return compareScalar(scalar, operator, value);
  }
  if (!task) return false;
  if (field === "story_points" && task.storyPoints === null) return operator === "is_empty";
  if (field === "custom_field" && !Object.hasOwn(task.customFields, leaf.field_key ?? "")) {
    return operator === "is_empty";
  }
  if (field === "assignee_ids" || field === "tags") {
    const values = field === "assignee_ids" ? task.assigneeIds : task.tags;
    if (operator === "is_empty") return values.length === 0;
    if (operator === "is_not_empty") return values.length > 0;
    if (operator === "contains") return values.includes(String(value));
    return !values.includes(String(value));
  }
  if (field === "start_date") return compareDate(task.startDate, operator, value);
  if (field === "due_date") return compareDate(task.dueDate, operator, value);
  const scalar =
    field === "status_id"
      ? task.statusId
      : field === "task_type_id"
        ? task.taskTypeId
        : field === "importance"
          ? task.importance
          : field === "custom_field"
            ? task.customFields[leaf.field_key ?? ""]
            : field === "title"
              ? task.title
              : field === "story_points"
                ? task.storyPoints
                : field === "sprint_id"
                  ? task.sprintId
                  : field === "parent_task_id"
                    ? task.parentTaskId
                    : task.reporterId;
  return compareScalar(scalar, operator, value);
}
