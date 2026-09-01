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
import { type DocumentScope, readDocumentScope } from "./postgres-scope-repository";
import {
  DOCUMENT_CONNECTION_TTL_MS,
  DOCUMENT_CONTEXT_HEADER,
  type DocumentConnectionState,
  documentPermissionVersion,
  encodeDocumentConnectionState,
} from "./realtime-protocol";

export type DocumentLobby = { className: string; name: string };

type UserSession = Awaited<ReturnType<typeof readCurrentUserSession>>;

export type DocumentRealtimeAuthDependencies = {
  now: () => number;
  readAgentSession: (request: Request, env: AppBindings) => Promise<AgentSession | null>;
  readDocumentScope: (env: AppBindings, documentId: string) => Promise<DocumentScope | null>;
  readProjectGrants: (
    env: AppBindings,
    userId: string,
    projectId: string,
  ) => Promise<PermissionGrant[] | null>;
  readUserSession: (request: Request, env: AppBindings) => Promise<UserSession>;
};

const defaultDependencies: DocumentRealtimeAuthDependencies = {
  now: Date.now,
  readAgentSession: readCurrentAgentSession,
  readDocumentScope,
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

function hasActiveDocumentReadGrant(
  session: AgentSession,
  scope: DocumentScope,
  now: number,
): boolean {
  return session.agent.capabilityGrants.some((grant) => {
    if (grant.status !== "active" || grant.capability !== "document.read" || !grant.constraints) {
      return false;
    }
    const validUntil = exactConstraintString(grant.constraints.validUntil);
    return (
      exactConstraintString(grant.constraints.organizationId) === scope.organizationId &&
      exactConstraintString(grant.constraints.projectId) === scope.projectId &&
      exactConstraintString(grant.constraints.documentId) === scope.documentId &&
      Boolean(validUntil && Number.isFinite(Date.parse(validUntil)) && Date.parse(validUntil) > now)
    );
  });
}

function trustedRequest(request: Request, state: DocumentConnectionState): Request {
  const headers = new Headers(request.headers);
  const names: string[] = [];
  headers.forEach((_value, name) => {
    names.push(name);
  });
  for (const name of names) {
    if (name.toLowerCase().startsWith("x-paca-document-")) headers.delete(name);
  }
  headers.set(DOCUMENT_CONTEXT_HEADER, encodeDocumentConnectionState(state));
  return new Request(request, { headers });
}

function hasTrustedBrowserOrigin(request: Request, env: AppBindings): boolean {
  const origin = request.headers.get("origin");
  return Boolean(origin && readTrustedOrigins(env).includes(origin));
}

export async function authorizeDocumentConnection(
  request: Request,
  lobby: DocumentLobby,
  env: AppBindings,
  overrides: Partial<DocumentRealtimeAuthDependencies> = {},
): Promise<Request | Response> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const now = dependencies.now();

  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return failure(400, "DOCUMENT_WEBSOCKET_REQUIRED");
  }
  if (lobby.className !== "DocumentParty") return failure(404, "DOCUMENT_PARTY_NOT_FOUND");
  if (!z.uuid().safeParse(lobby.name).success) return failure(404, "DOCUMENT_NOT_FOUND");

  const userSession = await dependencies.readUserSession(request, env);
  if (userSession) {
    if (!hasTrustedBrowserOrigin(request, env)) return failure(403, "DOCUMENT_ORIGIN_DENIED");
    const scope = await dependencies.readDocumentScope(env, lobby.name);
    if (!scope) return failure(404, "DOCUMENT_NOT_FOUND");
    const grants = await dependencies.readProjectGrants(env, userSession.user.id, scope.projectId);
    if (!grants || !hasGrant(grants, "docs", "read")) {
      return failure(403, "DOCUMENT_PERMISSION_DENIED");
    }
    const sessionExpiry = Date.parse(userSession.expiresAt);
    const expiresAt = Math.min(sessionExpiry, now + DOCUMENT_CONNECTION_TTL_MS);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      return failure(401, "DOCUMENT_SESSION_EXPIRED");
    }
    const base = {
      actorType: "user" as const,
      actorId: userSession.user.id,
      sessionId: userSession.id,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      documentId: scope.documentId,
      canWrite: hasGrant(grants, "docs", "write"),
    };
    return trustedRequest(request, {
      version: 1,
      ...base,
      issuedAt: now,
      expiresAt,
      nonce: crypto.randomUUID(),
      permissionVersion: await documentPermissionVersion(base),
    });
  }

  let agentSession: AgentSession | null;
  try {
    agentSession = await dependencies.readAgentSession(request, env);
  } catch {
    return failure(401, "DOCUMENT_AGENT_TOKEN_INVALID");
  }
  if (!agentSession) return failure(401, "DOCUMENT_AUTHENTICATION_REQUIRED");
  const jwtExpiry = readJwtExpiry(request);
  if (!jwtExpiry || jwtExpiry <= now) return failure(401, "DOCUMENT_AGENT_TOKEN_EXPIRED");
  const scope = await dependencies.readDocumentScope(env, lobby.name);
  if (!scope) return failure(404, "DOCUMENT_NOT_FOUND");
  if (!hasActiveDocumentReadGrant(agentSession, scope, now)) {
    return failure(403, "DOCUMENT_AGENT_GRANT_DENIED");
  }
  const base = {
    actorType: "agent" as const,
    actorId: agentSession.agentId,
    sessionId: null,
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    documentId: scope.documentId,
    canWrite: false,
  };
  return trustedRequest(request, {
    version: 1,
    ...base,
    issuedAt: now,
    expiresAt: Math.min(jwtExpiry, now + DOCUMENT_CONNECTION_TTL_MS),
    nonce: crypto.randomUUID(),
    permissionVersion: await documentPermissionVersion(base),
  });
}
