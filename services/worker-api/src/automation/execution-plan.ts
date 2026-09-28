import type { AutomationRunSnapshot } from "./run-protocol";

export type SnapshotNode = AutomationRunSnapshot["nodes"][number];

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
    throw new Error("AUTOMATION_ACTION_UNSUPPORTED");
  }
  if (
    Object.keys(node.config).some((key) => key !== "wait_minutes") ||
    !Number.isInteger(node.config.wait_minutes) ||
    typeof node.config.wait_minutes !== "number" ||
    node.config.wait_minutes < 1 ||
    node.config.wait_minutes > 10_080
  ) {
    throw new Error("AUTOMATION_WAIT_CONFIG_INVALID");
  }
  return node.config.wait_minutes;
}
