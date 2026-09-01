import type { AgentSession } from "@better-auth/agent-auth";
import * as z from "zod";

import { exactConstraintString } from "../agent-auth/capabilities";
import {
  readCurrentAgentSession,
  readCurrentUserSession,
  readTrustedOrigins,
} from "../auth/runtime";
import type { AppBindings } from "../bindings";
import { withDatabase } from "../database";
import { PostgresPacaPermissionStore } from "../permission/postgres-store";
import { PacaPermissionService } from "../permission/service";
import type { PermissionGrant } from "../permission/statement";
import { realtimePermissionVersion } from "./permission-version";
import {
  encodeConnectionState,
  REALTIME_CONNECTION_TTL_MS,
  REALTIME_CONTEXT_HEADER,
  type RealtimeConnectionState,
  type RealtimeNamespace,
} from "./protocol";

export type RealtimeLobby = { className: string; name: string };

type UserSession = Awaited<ReturnType<typeof readCurrentUserSession>>;

export type RealtimeAuthDependencies = {
  now: () => number;
  readAgentSession: (request: Request, env: AppBindings) => Promise<AgentSession | null>;
  readProjectGrants: (
    env: AppBindings,
    userId: string,
    projectId: string,
  ) => Promise<PermissionGrant[] | null>;
  readUserSession: (request: Request, env: AppBindings) => Promise<UserSession>;
};

const defaultDependencies: RealtimeAuthDependencies = {
  now: Date.now,
  readAgentSession: readCurrentAgentSession,
  readProjectGrants: (env, userId, projectId) =>
    withDatabase(env, (database) =>
      new PacaPermissionService(new PostgresPacaPermissionStore(database)).listProjectPermissions(
        userId,
        projectId,
      ),
    ),
  readUserSession: readCurrentUserSession,
};

function failure(status: 400 | 401 | 403 | 404, code: string): Response {
  return Response.json(
    { status: "error", code },
    { status, headers: { "cache-control": "no-store" } },
  );
}

function hasGrant(grants: readonly PermissionGrant[], resource: string, action: string): boolean {
  return grants.some(
    (grant) =>
      (grant.resource === "*" || grant.resource === resource) &&
      (grant.action === "*" || grant.action === action),
  );
}

export function userRealtimeNamespaces(grants: readonly PermissionGrant[]): RealtimeNamespace[] {
  const namespaces: RealtimeNamespace[] = [];
  if (hasGrant(grants, "tasks", "read")) namespaces.push("tasks");
  if (hasGrant(grants, "docs", "read")) namespaces.push("docs");
  if (hasGrant(grants, "workflows", "read")) namespaces.push("workflows");
  if (hasGrant(grants, "sprints", "read")) namespaces.push("sprints");
  return namespaces;
}

function readJwtExpiry(request: Request): number | null {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const payload = authorization.slice(7).split(".")[1];
  if (!payload) return null;
  try {
    const base64 = payload.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const value = JSON.parse(decoded) as Record<string, unknown>;
    return typeof value.exp === "number" && Number.isFinite(value.exp) ? value.exp * 1_000 : null;
  } catch {
    return null;
  }
}

function activeAgentSubscriptions(session: AgentSession, projectId: string, now: number) {
  const taskIds: string[] = [];
  const documentIds: string[] = [];
  for (const grant of session.agent.capabilityGrants) {
    if (grant.status !== "active" || !grant.constraints) continue;
    if (exactConstraintString(grant.constraints.projectId) !== projectId) continue;
    const validUntil = exactConstraintString(grant.constraints.validUntil);
    if (!validUntil || Date.parse(validUntil) <= now) continue;

    if (grant.capability === "task.read") {
      const taskId = exactConstraintString(grant.constraints.taskId);
      if (taskId && z.uuid().safeParse(taskId).success) taskIds.push(taskId);
    }
    if (grant.capability === "document.read") {
      const documentId = exactConstraintString(grant.constraints.documentId);
      if (documentId && z.uuid().safeParse(documentId).success) documentIds.push(documentId);
    }
  }

  return {
    taskIds: [...new Set(taskIds)].slice(0, 25),
    documentIds: [...new Set(documentIds)].slice(0, 25),
  };
}

function trustedRequest(request: Request, state: RealtimeConnectionState): Request {
  const headers = new Headers(request.headers);
  const names: string[] = [];
  headers.forEach((_value, name) => {
    names.push(name);
  });
  for (const name of names) {
    if (name.toLowerCase().startsWith("x-paca-realtime-")) headers.delete(name);
  }
  headers.set(REALTIME_CONTEXT_HEADER, encodeConnectionState(state));
  return new Request(request, { headers });
}

function hasTrustedBrowserOrigin(request: Request, env: AppBindings): boolean {
  const origin = request.headers.get("origin");
  return Boolean(origin && readTrustedOrigins(env).includes(origin));
}

export async function authorizeRealtimeConnection(
  request: Request,
  lobby: RealtimeLobby,
  env: AppBindings,
  overrides: Partial<RealtimeAuthDependencies> = {},
): Promise<Request | Response> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const now = dependencies.now();

  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return failure(400, "REALTIME_WEBSOCKET_REQUIRED");
  }

  if (lobby.className !== "ProjectParty" && lobby.className !== "UserParty") {
    return failure(404, "REALTIME_PARTY_NOT_FOUND");
  }
  if (!lobby.name || lobby.name.length > 255) return failure(404, "REALTIME_ROOM_NOT_FOUND");

  const userSession = await dependencies.readUserSession(request, env);
  if (userSession) {
    if (!hasTrustedBrowserOrigin(request, env)) return failure(403, "REALTIME_ORIGIN_DENIED");
    const sessionExpiry = Date.parse(userSession.expiresAt);
    const expiresAt = Math.min(sessionExpiry, now + REALTIME_CONNECTION_TTL_MS);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      return failure(401, "REALTIME_SESSION_EXPIRED");
    }

    if (lobby.className === "UserParty") {
      if (lobby.name !== userSession.user.id) return failure(403, "REALTIME_USER_SCOPE_DENIED");
      const permissionVersion = await realtimePermissionVersion({
        actorType: "user",
        actorId: userSession.user.id,
        sessionId: userSession.id,
        roomType: "user",
        roomId: lobby.name,
        namespaces: [],
        taskIds: [],
        documentIds: [],
      });
      return trustedRequest(request, {
        version: 1,
        actorType: "user",
        actorId: userSession.user.id,
        sessionId: userSession.id,
        roomType: "user",
        roomId: lobby.name,
        namespaces: [],
        taskIds: [],
        documentIds: [],
        issuedAt: now,
        expiresAt,
        nonce: crypto.randomUUID(),
        permissionVersion,
      });
    }

    if (!z.uuid().safeParse(lobby.name).success) return failure(404, "REALTIME_ROOM_NOT_FOUND");
    const grants = await dependencies.readProjectGrants(env, userSession.user.id, lobby.name);
    if (!grants) return failure(403, "REALTIME_PROJECT_SCOPE_DENIED");
    const namespaces = userRealtimeNamespaces(grants);
    if (namespaces.length === 0) return failure(403, "REALTIME_PROJECT_PERMISSION_DENIED");
    const permissionVersion = await realtimePermissionVersion({
      actorType: "user",
      actorId: userSession.user.id,
      sessionId: userSession.id,
      roomType: "project",
      roomId: lobby.name,
      namespaces,
      taskIds: [],
      documentIds: [],
    });

    return trustedRequest(request, {
      version: 1,
      actorType: "user",
      actorId: userSession.user.id,
      sessionId: userSession.id,
      roomType: "project",
      roomId: lobby.name,
      namespaces,
      taskIds: [],
      documentIds: [],
      issuedAt: now,
      expiresAt,
      nonce: crypto.randomUUID(),
      permissionVersion,
    });
  }

  if (lobby.className === "UserParty") return failure(401, "REALTIME_USER_SESSION_REQUIRED");
  if (!z.uuid().safeParse(lobby.name).success) return failure(404, "REALTIME_ROOM_NOT_FOUND");

  let agentSession: AgentSession | null;
  try {
    agentSession = await dependencies.readAgentSession(request, env);
  } catch {
    return failure(401, "REALTIME_AGENT_TOKEN_INVALID");
  }
  if (!agentSession) return failure(401, "REALTIME_AUTHENTICATION_REQUIRED");
  const jwtExpiry = readJwtExpiry(request);
  if (!jwtExpiry || jwtExpiry <= now) return failure(401, "REALTIME_AGENT_TOKEN_EXPIRED");
  const subscriptions = activeAgentSubscriptions(agentSession, lobby.name, now);
  const namespaces: RealtimeNamespace[] = [];
  if (subscriptions.taskIds.length > 0) namespaces.push("tasks");
  if (subscriptions.documentIds.length > 0) namespaces.push("docs");
  if (namespaces.length === 0) return failure(403, "REALTIME_AGENT_GRANT_DENIED");
  const permissionVersion = await realtimePermissionVersion({
    actorType: "agent",
    actorId: agentSession.agentId,
    sessionId: null,
    roomType: "project",
    roomId: lobby.name,
    namespaces,
    taskIds: subscriptions.taskIds,
    documentIds: subscriptions.documentIds,
  });

  return trustedRequest(request, {
    version: 1,
    actorType: "agent",
    actorId: agentSession.agentId,
    sessionId: null,
    roomType: "project",
    roomId: lobby.name,
    namespaces,
    taskIds: subscriptions.taskIds,
    documentIds: subscriptions.documentIds,
    issuedAt: now,
    expiresAt: Math.min(jwtExpiry, now + REALTIME_CONNECTION_TTL_MS),
    nonce: crypto.randomUUID(),
    permissionVersion,
  });
}
