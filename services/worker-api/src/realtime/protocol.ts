import * as z from "zod";

export const REALTIME_CONTEXT_HEADER = "x-paca-realtime-context";
export const REALTIME_PATH_PREFIX = "/ws/parties/";
export const REALTIME_CONNECTION_TTL_MS = 5 * 60_000;
export const REALTIME_MAX_EVENT_BYTES = 64 * 1024;

export const realtimeNamespaces = ["tasks", "docs", "workflows", "sprints"] as const;
export type RealtimeNamespace = (typeof realtimeNamespaces)[number];

const connectionStateSchema = z
  .object({
    version: z.literal(1),
    actorType: z.enum(["user", "agent"]),
    actorId: z.string().min(1).max(255),
    sessionId: z.string().min(1).max(255).nullable(),
    roomType: z.enum(["project", "user"]),
    roomId: z.string().min(1).max(255),
    namespaces: z.array(z.enum(realtimeNamespaces)).max(realtimeNamespaces.length),
    taskIds: z.array(z.uuid()).max(25),
    documentIds: z.array(z.uuid()).max(25),
    issuedAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    nonce: z.uuid(),
    permissionVersion: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((state, context) => {
    if (state.actorType === "user" && !state.sessionId) {
      context.addIssue({ code: "custom", message: "User connection requires sessionId" });
    }
    if (state.actorType === "agent" && state.sessionId) {
      context.addIssue({ code: "custom", message: "Agent connection cannot use sessionId" });
    }
    if (state.issuedAt >= state.expiresAt) {
      context.addIssue({ code: "custom", message: "Connection lifetime is invalid" });
    }
  });

export type RealtimeConnectionState = z.infer<typeof connectionStateSchema>;
export type RealtimeConnectionStateView = Omit<
  Readonly<RealtimeConnectionState>,
  "namespaces" | "taskIds" | "documentIds"
> & {
  readonly namespaces: readonly RealtimeNamespace[];
  readonly taskIds: readonly string[];
  readonly documentIds: readonly string[];
};

const realtimeEnvelopeSchema = z
  .object({
    type: z.string().min(1).max(100),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export type RealtimeEnvelope = z.infer<typeof realtimeEnvelopeSchema>;

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export function normalizeConnectionState(state: RealtimeConnectionState): RealtimeConnectionState {
  return connectionStateSchema.parse({
    ...state,
    namespaces: unique(state.namespaces),
    taskIds: unique(state.taskIds),
    documentIds: unique(state.documentIds),
  });
}

export function encodeConnectionState(state: RealtimeConnectionState): string {
  const encoded = encodeURIComponent(JSON.stringify(normalizeConnectionState(state)));
  if (new TextEncoder().encode(encoded).byteLength > 1_800) {
    throw new Error("REALTIME_CONNECTION_CONTEXT_TOO_LARGE");
  }
  return encoded;
}

export function decodeConnectionState(value: string | null): RealtimeConnectionState | null {
  if (!value) return null;
  try {
    return connectionStateSchema.parse(JSON.parse(decodeURIComponent(value)));
  } catch {
    return null;
  }
}

export function parseRealtimeEnvelope(value: unknown): RealtimeEnvelope {
  const envelope = realtimeEnvelopeSchema.parse(value);
  if (new TextEncoder().encode(JSON.stringify(envelope)).byteLength > REALTIME_MAX_EVENT_BYTES) {
    throw new Error("REALTIME_EVENT_TOO_LARGE");
  }
  return envelope;
}

export function realtimeEventNamespace(type: string): RealtimeNamespace | null {
  if (type.startsWith("task.") || type.startsWith("github.") || type.startsWith("agent.")) {
    return "tasks";
  }
  if (type === "workflow.assigned") return "tasks";
  if (type.startsWith("workflow.") || type.startsWith("automation.")) return "workflows";
  if (type.startsWith("doc.")) return "docs";
  if (type.startsWith("sprint.") || type.startsWith("view.")) return "sprints";
  return null;
}

function payloadId(payload: Record<string, unknown>, names: readonly string[]): string | null {
  for (const name of names) {
    const value = payload[name];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

export function canReceiveRealtimeEvent(
  state: RealtimeConnectionStateView,
  event: RealtimeEnvelope,
  now = Date.now(),
): boolean {
  if (state.issuedAt > now || state.expiresAt <= now) return false;

  if (state.roomType === "user") {
    if (state.actorType !== "user" || state.actorId !== state.roomId) return false;
    if (event.type.startsWith("notification.")) {
      return event.payload.recipient_user_id === state.roomId;
    }
    if (event.type.startsWith("agent.")) {
      return event.payload.actor_user_id === state.roomId;
    }
    return false;
  }

  if (event.payload.project_id !== state.roomId) return false;
  const namespace = realtimeEventNamespace(event.type);
  if (!namespace || !state.namespaces.includes(namespace)) return false;
  if (state.actorType === "user") return true;

  if (namespace === "tasks") {
    const taskId = payloadId(event.payload, ["task_id"]);
    return Boolean(taskId && state.taskIds.includes(taskId));
  }
  if (namespace === "docs") {
    const documentId = payloadId(event.payload, ["document_id", "doc_id"]);
    return Boolean(documentId && state.documentIds.includes(documentId));
  }
  return false;
}

export function realtimeClientMessage(event: RealtimeEnvelope, id?: string) {
  return {
    ...(id ? { id } : {}),
    kind: event.type.startsWith("notification.") ? ("notification" as const) : ("event" as const),
    type: event.type,
    payload: event.payload,
  };
}
