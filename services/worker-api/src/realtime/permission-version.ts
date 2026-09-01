import type { RealtimeNamespace } from "./protocol";

export type RealtimePermissionSnapshot = {
  actorType: "user" | "agent";
  actorId: string;
  sessionId: string | null;
  roomType: "project" | "user";
  roomId: string;
  namespaces: readonly RealtimeNamespace[];
  taskIds: readonly string[];
  documentIds: readonly string[];
};

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export async function realtimePermissionVersion(
  snapshot: RealtimePermissionSnapshot,
): Promise<string> {
  const canonical = JSON.stringify({
    actorType: snapshot.actorType,
    actorId: snapshot.actorId,
    sessionId: snapshot.sessionId,
    roomType: snapshot.roomType,
    roomId: snapshot.roomId,
    namespaces: sortedUnique(snapshot.namespaces),
    taskIds: sortedUnique(snapshot.taskIds),
    documentIds: sortedUnique(snapshot.documentIds),
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
