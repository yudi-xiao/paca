import * as z from "zod";

import type { TaskUpdateInput } from "../task/service";
import { type GraphEdge, type GraphNode, validateAutomationActivation } from "./graph";
import type { AutomationRunSnapshot } from "./run-protocol";

export type SnapshotNode = AutomationRunSnapshot["nodes"][number];

export class AutomationExecutionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AutomationExecutionError";
  }
}

const statusTriggerConfigSchema = z.object({ status_id: z.uuid().nullable().optional() }).strict();
const taskUpdateConfigSchema = z
  .object({
    update: z
      .object({
        title: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .refine((title) => !title.includes("{{") && !title.includes("}}"))
          .optional(),
        importance: z.number().int().min(0).max(1_000_000).optional(),
        story_points: z.number().int().min(0).max(1_000_000).nullable().optional(),
        tags: z.array(z.string().max(100)).max(50).optional(),
      })
      .strict()
      .refine((update) => Object.keys(update).length > 0),
  })
  .strict();

export function validateRunnableAutomationGraph(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): void {
  validateAutomationActivation(nodes, edges);
  for (const node of nodes) {
    if (node.kind === "trigger") {
      if (node.type === "task_created" && Object.keys(node.config).length === 0) continue;
      if (
        node.type === "status_changed" &&
        statusTriggerConfigSchema.safeParse(node.config).success
      ) {
        continue;
      }
      throw new AutomationExecutionError("AUTOMATION_TRIGGER_CONFIG_UNSUPPORTED");
    }
    if (node.kind !== "action") {
      throw new AutomationExecutionError("AUTOMATION_NODE_NOT_EXECUTABLE");
    }
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
  if (eventType === "task_created") {
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
  throw new AutomationExecutionError("AUTOMATION_TRIGGER_CONFIG_UNSUPPORTED");
}

export function taskUpdateFromNode(
  node: Pick<SnapshotNode, "kind" | "type" | "config">,
): TaskUpdateInput {
  if (node.kind !== "action" || node.type !== "update_task") {
    throw new AutomationExecutionError("AUTOMATION_ACTION_UNSUPPORTED");
  }
  const parsed = taskUpdateConfigSchema.safeParse(node.config);
  if (!parsed.success) {
    throw new AutomationExecutionError("AUTOMATION_UPDATE_TASK_CONFIG_INVALID");
  }
  const update = parsed.data.update;
  return {
    title: update.title,
    importance: update.importance,
    storyPoints: update.story_points,
    tags: update.tags,
  };
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
