import { createMiddleware } from "hono/factory";

import { readCurrentUserSessionFromDatabase } from "../auth/runtime";
import type { AppBindings, AppVariables } from "../bindings";
import { withDatabase } from "../database";
import { PostgresPacaPermissionStore } from "./postgres-store";
import { PacaPermissionService, type PermissionDecision } from "./service";
import type { PermissionGrant, PermissionRequest } from "./statement";
import { validatePermissionRequest } from "./statement";

export type SystemPermissionSnapshot =
  | { authenticated: false }
  | { authenticated: true; userId: string; grants: PermissionGrant[] };

export type SystemPermissionDecisionSnapshot =
  | { authenticated: false }
  | { authenticated: true; userId: string; grants: PermissionGrant[]; allowed: boolean };

export type ProjectPermissionSnapshot =
  | { authenticated: false }
  | { authenticated: true; userId: string; decision: PermissionDecision };

export type OrganizationPermissionSnapshot = ProjectPermissionSnapshot;

export type LoadSystemPermissions = (
  request: Request,
  env: AppBindings,
) => Promise<SystemPermissionSnapshot>;

export type AuthorizeSystemPermission = (
  request: Request,
  env: AppBindings,
  permissions: PermissionRequest,
) => Promise<SystemPermissionDecisionSnapshot>;

export type AuthorizeProjectPermission = (
  request: Request,
  env: AppBindings,
  projectId: string,
  permissions: PermissionRequest,
) => Promise<ProjectPermissionSnapshot>;

export type AuthorizeOrganizationPermission = (
  request: Request,
  env: AppBindings,
  organizationId: string,
  permissions: PermissionRequest,
) => Promise<OrganizationPermissionSnapshot>;

export const loadSystemPermissions: LoadSystemPermissions = (request, env) =>
  withDatabase(env, async (database) => {
    const session = await readCurrentUserSessionFromDatabase(database, request, env);
    if (!session) return { authenticated: false };

    const service = new PacaPermissionService(new PostgresPacaPermissionStore(database));
    return {
      authenticated: true,
      userId: session.user.id,
      grants: await service.listSystemPermissions(session.user.id),
    };
  });

export const authorizeSystemPermission: AuthorizeSystemPermission = (request, env, permissions) =>
  withDatabase(env, async (database) => {
    const session = await readCurrentUserSessionFromDatabase(database, request, env);
    if (!session) return { authenticated: false };

    const service = new PacaPermissionService(new PostgresPacaPermissionStore(database));
    const decision = await service.hasSystemPermission(session.user.id, permissions);
    return {
      authenticated: true,
      userId: session.user.id,
      grants: decision.grants,
      allowed: decision.allowed,
    };
  });

export const authorizeProjectPermission: AuthorizeProjectPermission = (
  request,
  env,
  projectId,
  permissions,
) =>
  withDatabase(env, async (database) => {
    const session = await readCurrentUserSessionFromDatabase(database, request, env);
    if (!session) return { authenticated: false };

    const service = new PacaPermissionService(new PostgresPacaPermissionStore(database));
    return {
      authenticated: true,
      userId: session.user.id,
      decision: await service.hasProjectPermission(session.user.id, projectId, permissions),
    };
  });

export const authorizeOrganizationPermission: AuthorizeOrganizationPermission = (
  request,
  env,
  organizationId,
  permissions,
) =>
  withDatabase(env, async (database) => {
    const session = await readCurrentUserSessionFromDatabase(database, request, env);
    if (!session) return { authenticated: false };

    const service = new PacaPermissionService(new PostgresPacaPermissionStore(database));
    return {
      authenticated: true,
      userId: session.user.id,
      decision: await service.hasOrganizationPermission(
        session.user.id,
        organizationId,
        permissions,
      ),
    };
  });

type PermissionHonoEnvironment = {
  Bindings: AppBindings;
  Variables: AppVariables;
};

export function requireSystemPermission(
  authorize: AuthorizeSystemPermission,
  permissions: PermissionRequest,
) {
  validatePermissionRequest("system", permissions);

  return createMiddleware<PermissionHonoEnvironment>(async (context, next) => {
    context.header("cache-control", "no-store");
    const snapshot = await authorize(context.req.raw, context.env, permissions);

    if (!snapshot.authenticated) {
      return context.json(
        {
          success: false as const,
          error_code: "AUTH_UNAUTHENTICATED",
          error: "Authentication required",
          request_id: context.get("requestId"),
        },
        401,
      );
    }

    if (!snapshot.allowed) {
      return context.json(
        {
          success: false as const,
          error_code: "PERMISSION_DENIED",
          error: "Permission denied",
          request_id: context.get("requestId"),
        },
        403,
      );
    }

    context.set("permissionActorId", snapshot.userId);
    context.set("permissionGrants", snapshot.grants);
    await next();
  });
}

export function requireProjectPermission(
  authorize: AuthorizeProjectPermission,
  permissions: PermissionRequest,
) {
  // Reject invalid route declarations during app construction instead of at
  // request time. Runtime callers still pass through the service validator.
  validatePermissionRequest("project", permissions);

  return createMiddleware<PermissionHonoEnvironment>(async (context, next) => {
    context.header("cache-control", "no-store");
    const projectId = context.req.param("projectId");
    if (!projectId) {
      return context.json(
        {
          success: false as const,
          error_code: "PROJECT_NOT_FOUND",
          error: "Project not found",
          request_id: context.get("requestId"),
        },
        404,
      );
    }
    const snapshot = await authorize(context.req.raw, context.env, projectId, permissions);

    if (!snapshot.authenticated) {
      return context.json(
        {
          success: false as const,
          error_code: "AUTH_UNAUTHENTICATED",
          error: "Authentication required",
          request_id: context.get("requestId"),
        },
        401,
      );
    }

    if (!snapshot.decision.scopeExists || !snapshot.decision.allowed) {
      return context.json(
        {
          success: false as const,
          error_code: "PERMISSION_DENIED",
          error: "Permission denied",
          request_id: context.get("requestId"),
        },
        403,
      );
    }

    context.set("permissionActorId", snapshot.userId);
    context.set("permissionGrants", snapshot.decision.grants);
    await next();
  });
}

export function requireOrganizationPermission(
  authorize: AuthorizeOrganizationPermission,
  organizationId: string,
  permissions: PermissionRequest,
) {
  validatePermissionRequest("organization", permissions);

  return createMiddleware<PermissionHonoEnvironment>(async (context, next) => {
    context.header("cache-control", "no-store");
    const snapshot = await authorize(context.req.raw, context.env, organizationId, permissions);
    if (!snapshot.authenticated) {
      return context.json(
        {
          success: false as const,
          error_code: "AUTH_UNAUTHENTICATED",
          error: "Authentication required",
          request_id: context.get("requestId"),
        },
        401,
      );
    }
    if (!snapshot.decision.scopeExists || !snapshot.decision.allowed) {
      return context.json(
        {
          success: false as const,
          error_code: "PERMISSION_DENIED",
          error: "Permission denied",
          request_id: context.get("requestId"),
        },
        403,
      );
    }

    context.set("permissionActorId", snapshot.userId);
    context.set("permissionGrants", snapshot.decision.grants);
    await next();
  });
}

export function requireOrganizationPermissionFromParam(
  authorize: AuthorizeOrganizationPermission,
  permissions: PermissionRequest,
  parameterName = "organizationId",
) {
  validatePermissionRequest("organization", permissions);

  return createMiddleware<PermissionHonoEnvironment>(async (context, next) => {
    context.header("cache-control", "no-store");
    const organizationId = context.req.param(parameterName)?.trim();
    if (!organizationId) {
      return context.json(
        {
          success: false as const,
          error_code: "ORGANIZATION_NOT_FOUND",
          error: "Organization not found",
          request_id: context.get("requestId"),
        },
        404,
      );
    }

    const snapshot = await authorize(context.req.raw, context.env, organizationId, permissions);
    if (!snapshot.authenticated) {
      return context.json(
        {
          success: false as const,
          error_code: "AUTH_UNAUTHENTICATED",
          error: "Authentication required",
          request_id: context.get("requestId"),
        },
        401,
      );
    }
    if (!snapshot.decision.scopeExists) {
      return context.json(
        {
          success: false as const,
          error_code: "ORGANIZATION_NOT_FOUND",
          error: "Organization not found",
          request_id: context.get("requestId"),
        },
        404,
      );
    }
    if (!snapshot.decision.allowed) {
      return context.json(
        {
          success: false as const,
          error_code: "PERMISSION_DENIED",
          error: "Permission denied",
          request_id: context.get("requestId"),
        },
        403,
      );
    }

    context.set("permissionActorId", snapshot.userId);
    context.set("permissionGrants", snapshot.decision.grants);
    await next();
  });
}
