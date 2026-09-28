import type { PacaAutomationNodeKind } from "../db/schema";

export const automationGraphErrorCodes = {
  nameInvalid: "AUTOMATION_NAME_INVALID",
  descriptionInvalid: "AUTOMATION_DESCRIPTION_INVALID",
  nodeInvalidKind: "AUTOMATION_NODE_INVALID_KIND",
  nodeInvalidType: "AUTOMATION_NODE_INVALID_TYPE",
  nodeConfigInvalid: "AUTOMATION_NODE_CONFIG_INVALID",
  nodePositionInvalid: "AUTOMATION_NODE_POSITION_INVALID",
  edgeSelfLoop: "AUTOMATION_EDGE_SELF_LOOP",
  edgeCrossAutomation: "AUTOMATION_EDGE_CROSS_AUTOMATION",
  edgeDuplicate: "AUTOMATION_EDGE_DUPLICATE",
  edgeCycle: "AUTOMATION_EDGE_CYCLE",
  edgeIntoTrigger: "AUTOMATION_EDGE_INTO_TRIGGER",
  edgeHandleRequired: "AUTOMATION_EDGE_HANDLE_REQUIRED",
  edgeHandleNotAllowed: "AUTOMATION_EDGE_HANDLE_NOT_ALLOWED",
  activateNoTrigger: "AUTOMATION_ACTIVATE_NO_TRIGGER",
  activateNoAction: "AUTOMATION_ACTIVATE_NO_ACTION",
  activateUnreachableAction: "AUTOMATION_ACTIVATE_UNREACHABLE_ACTION",
} as const;

export type AutomationGraphErrorCode =
  (typeof automationGraphErrorCodes)[keyof typeof automationGraphErrorCodes];

export class AutomationGraphError extends Error {
  constructor(readonly code: AutomationGraphErrorCode) {
    super(code);
    this.name = "AutomationGraphError";
  }
}

export type GraphNode = {
  id: string;
  automationId: string;
  kind: PacaAutomationNodeKind;
  type: string;
  config: Record<string, unknown>;
};

export type GraphEdge = {
  sourceNodeId: string;
  sourceHandle: string | null;
  targetNodeId: string;
};

const triggerTypes = new Set([
  "status_changed",
  "task_created",
  "assignee_changed",
  "priority_changed",
  "tag_added",
  "due_date_reached",
  "predecessor_done",
  "cron",
  "api_trigger",
  "sprint_created",
  "sprint_started",
  "sprint_completed",
  "sprint_deleted",
]);

const actionTypes = new Set([
  "update_task",
  "trigger_ai_agent",
  "call_api",
  "wait",
  "update_sprint",
  "complete_sprint",
]);

export function normalizeAutomationName(value: string): string {
  const name = value.trim();
  if (name.length === 0 || name.length > 255) {
    throw new AutomationGraphError(automationGraphErrorCodes.nameInvalid);
  }
  return name;
}

export function validateAutomationDescription(value: string): string {
  if (value.length > 10_000) {
    throw new AutomationGraphError(automationGraphErrorCodes.descriptionInvalid);
  }
  return value;
}

export function validateAutomationNode(input: {
  kind: string;
  type: string;
  config: unknown;
  posX: number;
  posY: number;
}): asserts input is {
  kind: PacaAutomationNodeKind;
  type: string;
  config: Record<string, unknown>;
  posX: number;
  posY: number;
} {
  if (input.kind !== "trigger" && input.kind !== "condition" && input.kind !== "action") {
    throw new AutomationGraphError(automationGraphErrorCodes.nodeInvalidKind);
  }
  if (
    (input.kind === "trigger" && !triggerTypes.has(input.type)) ||
    (input.kind === "condition" && input.type !== "condition") ||
    (input.kind === "action" && !actionTypes.has(input.type))
  ) {
    // Plugin-contributed types become valid only once their signed manifest and
    // execution adapter are installed. A draft must not imply they can run.
    throw new AutomationGraphError(automationGraphErrorCodes.nodeInvalidType);
  }
  if (input.config === null || typeof input.config !== "object" || Array.isArray(input.config)) {
    throw new AutomationGraphError(automationGraphErrorCodes.nodeConfigInvalid);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(input.config);
  } catch {
    throw new AutomationGraphError(automationGraphErrorCodes.nodeConfigInvalid);
  }
  if (!serialized || serialized.length > 65_536) {
    throw new AutomationGraphError(automationGraphErrorCodes.nodeConfigInvalid);
  }
  if (input.kind === "condition") {
    conditionHandles(input.config as Record<string, unknown>);
  }
  if (!Number.isFinite(input.posX) || !Number.isFinite(input.posY)) {
    throw new AutomationGraphError(automationGraphErrorCodes.nodePositionInvalid);
  }
}

function conditionHandles(config: Record<string, unknown>): Set<string> {
  const branches = config.branches;
  if (!Array.isArray(branches)) {
    throw new AutomationGraphError(automationGraphErrorCodes.nodeConfigInvalid);
  }
  const handles = new Set<string>(["else"]);
  for (const branch of branches) {
    if (
      branch === null ||
      typeof branch !== "object" ||
      Array.isArray(branch) ||
      !("handle" in branch) ||
      typeof branch.handle !== "string" ||
      branch.handle.trim() !== branch.handle ||
      branch.handle.length === 0 ||
      branch.handle.length > 100 ||
      handles.has(branch.handle)
    ) {
      throw new AutomationGraphError(automationGraphErrorCodes.nodeConfigInvalid);
    }
    handles.add(branch.handle);
  }
  return handles;
}

export function validateOutgoingConditionHandles(
  node: GraphNode,
  edges: readonly GraphEdge[],
): void {
  if (node.kind !== "condition") return;
  const handles = conditionHandles(node.config);
  for (const edge of edges) {
    if (edge.sourceNodeId !== node.id) continue;
    if (edge.sourceHandle === null || !handles.has(edge.sourceHandle)) {
      throw new AutomationGraphError(automationGraphErrorCodes.edgeHandleNotAllowed);
    }
  }
}

export function validateAutomationEdge(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  candidate: GraphEdge,
): void {
  if (candidate.sourceNodeId === candidate.targetNodeId) {
    throw new AutomationGraphError(automationGraphErrorCodes.edgeSelfLoop);
  }
  const source = nodes.find((node) => node.id === candidate.sourceNodeId);
  const target = nodes.find((node) => node.id === candidate.targetNodeId);
  if (!source || !target || source.automationId !== target.automationId) {
    throw new AutomationGraphError(automationGraphErrorCodes.edgeCrossAutomation);
  }
  if (target.kind === "trigger") {
    throw new AutomationGraphError(automationGraphErrorCodes.edgeIntoTrigger);
  }
  if (source.kind === "condition") {
    if (candidate.sourceHandle === null) {
      throw new AutomationGraphError(automationGraphErrorCodes.edgeHandleRequired);
    }
    if (!conditionHandles(source.config).has(candidate.sourceHandle)) {
      throw new AutomationGraphError(automationGraphErrorCodes.edgeHandleNotAllowed);
    }
  } else if (candidate.sourceHandle !== null) {
    throw new AutomationGraphError(automationGraphErrorCodes.edgeHandleNotAllowed);
  }
  if (
    edges.some(
      (edge) =>
        edge.sourceNodeId === candidate.sourceNodeId &&
        edge.sourceHandle === candidate.sourceHandle &&
        edge.targetNodeId === candidate.targetNodeId,
    )
  ) {
    throw new AutomationGraphError(automationGraphErrorCodes.edgeDuplicate);
  }

  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = outgoing.get(edge.sourceNodeId) ?? [];
    targets.push(edge.targetNodeId);
    outgoing.set(edge.sourceNodeId, targets);
  }
  const pending = [candidate.targetNodeId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (!nodeId || visited.has(nodeId)) continue;
    if (nodeId === candidate.sourceNodeId) {
      throw new AutomationGraphError(automationGraphErrorCodes.edgeCycle);
    }
    visited.add(nodeId);
    pending.push(...(outgoing.get(nodeId) ?? []));
  }
}

export function validateAutomationActivation(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): void {
  const triggers = nodes.filter((node) => node.kind === "trigger");
  if (triggers.length === 0) {
    throw new AutomationGraphError(automationGraphErrorCodes.activateNoTrigger);
  }
  if (!nodes.some((node) => node.kind === "action")) {
    throw new AutomationGraphError(automationGraphErrorCodes.activateNoAction);
  }
  const reachable = new Set(triggers.map((node) => node.id));
  const pending = [...reachable];
  while (pending.length > 0) {
    const sourceId = pending.pop();
    for (const edge of edges) {
      if (edge.sourceNodeId !== sourceId || reachable.has(edge.targetNodeId)) continue;
      reachable.add(edge.targetNodeId);
      pending.push(edge.targetNodeId);
    }
  }
  if (!nodes.some((node) => node.kind === "action" && reachable.has(node.id))) {
    throw new AutomationGraphError(automationGraphErrorCodes.activateUnreachableAction);
  }
}
