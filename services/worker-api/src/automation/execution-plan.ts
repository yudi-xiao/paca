import * as z from "zod";

import type { TaskUpdateInput } from "../task/service";
import { type ConditionTarget, conditionConfigFromNode, targetSchema } from "./condition";
import { AutomationExecutionError } from "./errors";
import {
  type GraphEdge,
  type GraphNode,
  validateAutomationActivation,
  validateOutgoingConditionHandles,
} from "./graph";
import type { AutomationRunSnapshot } from "./run-protocol";

export type SnapshotNode = AutomationRunSnapshot["nodes"][number];

const statusTriggerConfigSchema = z.object({ status_id: z.uuid().nullable().optional() }).strict();
const tagAddedTriggerConfigSchema = z
  .object({ tag: z.string().trim().min(1).max(100).optional() })
  .strict();
const taskDateSchema = z
  .string()
  .refine((value) => {
    if (!/^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.000)?Z)?$/u.test(value)) return false;
    const date = value.slice(0, 10);
    const [year, month, day] = date.split("-").map(Number);
    const parsed = new Date(Date.UTC(year as number, (month as number) - 1, day));
    return (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === (month as number) - 1 &&
      parsed.getUTCDate() === day
    );
  })
  .transform((value) => value.slice(0, 10));
const taskUpdateConfigSchema = z
  .object({
    update: z
      .object({
        task_type_id: z.uuid().optional(),
        status_id: z.uuid().optional(),
        sprint_id: z.uuid().optional(),
        parent_task_id: z.uuid().optional(),
        title: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .refine((title) => !title.includes("{{") && !title.includes("}}"))
          .optional(),
        description: z
          .array(z.unknown())
          .refine((value) => JSON.stringify(value).length <= 256_000)
          .optional(),
        importance: z.number().int().min(0).max(1_000_000).optional(),
        story_points: z.number().int().min(0).max(1_000_000).nullable().optional(),
        assignee_ids: z.array(z.uuid()).max(20).optional(),
        reporter_id: z.uuid().optional(),
        custom_fields: z
          .record(z.string().min(1).max(100), z.unknown())
          .refine(
            (value) => Object.keys(value).length > 0 && JSON.stringify(value).length <= 64_000,
          )
          .optional(),
        start_date: taskDateSchema.optional(),
        due_date: taskDateSchema.optional(),
        tags: z.array(z.string().max(100)).max(50).optional(),
      })
      .strict()
      .refine((update) => Object.keys(update).length > 0),
    target: targetSchema
      .refine((target) =>
        target.kind === "other" ? target.other_task_id !== undefined : !target.other_task_id,
      )
      .optional(),
  })
  .strict();

export function validateRunnableAutomationGraph(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): void {
  validateAutomationActivation(nodes, edges);
  for (const node of nodes) {
    if (node.kind === "trigger") {
      if (
        (node.type === "task_created" ||
          node.type === "assignee_changed" ||
          node.type === "priority_changed") &&
        Object.keys(node.config).length === 0
      ) {
        continue;
      }
      if (
        node.type === "status_changed" &&
        statusTriggerConfigSchema.safeParse(node.config).success
      ) {
        continue;
      }
      if (node.type === "tag_added" && tagAddedTriggerConfigSchema.safeParse(node.config).success) {
        continue;
      }
      throw new AutomationExecutionError("AUTOMATION_TRIGGER_CONFIG_UNSUPPORTED");
    }
    if (node.kind === "condition") {
      conditionConfigFromNode(node);
      validateOutgoingConditionHandles(node, edges);
      continue;
    }
    if (node.kind !== "action")
      throw new AutomationExecutionError("AUTOMATION_NODE_NOT_EXECUTABLE");
    if (node.type === "wait") {
      waitMinutes(node);
    } else if (node.type === "update_task") {
      taskUpdateFromNode(node);
    } else {
      throw new AutomationExecutionError("AUTOMATION_ACTION_UNSUPPORTED");
    }
  }
  const triggerIds = nodes.filter((node) => node.kind === "trigger").map((node) => node.id);
  const reachable = new Set<string>();
  const pending = [...triggerIds];
  while (pending.length > 0) {
    const id = pending.pop();
    if (!id || reachable.has(id)) continue;
    reachable.add(id);
    pending.push(
      ...edges.filter((edge) => edge.sourceNodeId === id).map((edge) => edge.targetNodeId),
    );
  }
  if (nodes.some((node) => node.kind === "action" && !reachable.has(node.id))) {
    throw new AutomationExecutionError("AUTOMATION_ACTIVATE_UNREACHABLE_ACTION");
  }
}

export function matchesTaskTrigger(
  eventType: string,
  payload: Record<string, unknown>,
  node: Pick<GraphNode, "type" | "config">,
): boolean {
  if (node.type !== eventType) return false;
  if (
    eventType === "task_created" ||
    eventType === "assignee_changed" ||
    eventType === "priority_changed"
  ) {
    if (Object.keys(node.config).length !== 0) {
      throw new AutomationExecutionError("AUTOMATION_TRIGGER_CONFIG_UNSUPPORTED");
    }
    return true;
  }
  if (eventType === "status_changed") {
    const parsed = statusTriggerConfigSchema.safeParse(node.config);
    if (!parsed.success) {
      throw new AutomationExecutionError("AUTOMATION_TRIGGER_CONFIG_UNSUPPORTED");
    }
    return parsed.data.status_id == null || parsed.data.status_id === payload.status_id;
  }
  if (eventType === "tag_added") {
    const parsed = tagAddedTriggerConfigSchema.safeParse(node.config);
    if (!parsed.success) {
      throw new AutomationExecutionError("AUTOMATION_TRIGGER_CONFIG_UNSUPPORTED");
    }
    const added = payload.added_tags;
    if (!Array.isArray(added) || !added.every((tag) => typeof tag === "string")) {
      throw new AutomationExecutionError("AUTOMATION_EVENT_PAYLOAD_INVALID");
    }
    return !parsed.data.tag || added.includes(parsed.data.tag);
  }
  throw new AutomationExecutionError("AUTOMATION_TRIGGER_CONFIG_UNSUPPORTED");
}

export function taskUpdateActionFromNode(node: Pick<SnapshotNode, "kind" | "type" | "config">): {
  update: TaskUpdateInput;
  target: ConditionTarget | undefined;
} {
  if (node.kind !== "action" || node.type !== "update_task") {
    throw new AutomationExecutionError("AUTOMATION_ACTION_UNSUPPORTED");
  }
  const parsed = taskUpdateConfigSchema.safeParse(node.config);
  if (!parsed.success) {
    throw new AutomationExecutionError("AUTOMATION_UPDATE_TASK_CONFIG_INVALID");
  }
  const update = parsed.data.update;
  return {
    target: parsed.data.target,
    update: {
      taskTypeId: update.task_type_id,
      statusId: update.status_id,
      sprintId: update.sprint_id,
      parentTaskId: update.parent_task_id,
      title: update.title,
      description: update.description,
      importance: update.importance,
      storyPoints: update.story_points,
      assigneeIds: update.assignee_ids,
      reporterId: update.reporter_id,
      customFieldPatch: update.custom_fields,
      startDate: update.start_date,
      dueDate: update.due_date,
      tags: update.tags,
    },
  };
}

export function taskUpdateFromNode(
  node: Pick<SnapshotNode, "kind" | "type" | "config">,
): TaskUpdateInput {
  return taskUpdateActionFromNode(node).update;
}

export function orderedReachableNodes(
  snapshot: AutomationRunSnapshot,
  triggerNodeId: string,
): SnapshotNode[] {
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const trigger = nodes.get(triggerNodeId);
  if (!trigger || trigger.kind !== "trigger") throw new Error("AUTOMATION_TRIGGER_NODE_INVALID");
  const outgoing = new Map<string, string[]>();
  for (const edge of snapshot.edges) {
    if (!nodes.has(edge.sourceNodeId) || !nodes.has(edge.targetNodeId)) {
      throw new Error("AUTOMATION_SNAPSHOT_EDGE_INVALID");
    }
    const targets = outgoing.get(edge.sourceNodeId) ?? [];
    targets.push(edge.targetNodeId);
    outgoing.set(edge.sourceNodeId, targets);
  }
  const reachable = new Set<string>();
  const pending = [triggerNodeId];
  while (pending.length > 0) {
    const id = pending.pop();
    if (!id || reachable.has(id)) continue;
    reachable.add(id);
    pending.push(...(outgoing.get(id) ?? []));
  }
  const indegree = new Map([...reachable].map((id) => [id, 0]));
  for (const edge of snapshot.edges) {
    if (reachable.has(edge.sourceNodeId) && reachable.has(edge.targetNodeId)) {
      indegree.set(edge.targetNodeId, (indegree.get(edge.targetNodeId) ?? 0) + 1);
    }
  }
  const ready = [...reachable].filter((id) => indegree.get(id) === 0).sort();
  const ordered: SnapshotNode[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (!id) break;
    const node = nodes.get(id);
    if (!node) throw new Error("AUTOMATION_SNAPSHOT_NODE_INVALID");
    ordered.push(node);
    for (const targetId of outgoing.get(id) ?? []) {
      if (!reachable.has(targetId)) continue;
      const remaining = (indegree.get(targetId) ?? 0) - 1;
      indegree.set(targetId, remaining);
      if (remaining === 0) {
        ready.push(targetId);
        ready.sort();
      }
    }
  }
  if (ordered.length !== reachable.size) throw new Error("AUTOMATION_SNAPSHOT_CYCLE");
  return ordered;
}

export function waitMinutes(node: SnapshotNode): number {
  if (node.kind !== "action" || node.type !== "wait") {
    throw new AutomationExecutionError("AUTOMATION_ACTION_UNSUPPORTED");
  }
  if (
    Object.keys(node.config).some((key) => key !== "wait_minutes") ||
    !Number.isInteger(node.config.wait_minutes) ||
    typeof node.config.wait_minutes !== "number" ||
    node.config.wait_minutes < 1 ||
    node.config.wait_minutes > 10_080
  ) {
    throw new AutomationExecutionError("AUTOMATION_WAIT_CONFIG_INVALID");
  }
  return node.config.wait_minutes;
}
