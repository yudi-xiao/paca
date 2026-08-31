import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  sessionMiddleware,
} from "better-auth/api";
import * as z from "zod";

import type { PacaPermissionService } from "./service";
import {
  type PermissionGrant,
  type PermissionRequest,
  type PermissionScope,
  permissionRequestFromUnknown,
  toLegacyPermissionKey,
  validatePermissionRequest,
} from "./statement";

const permissionRequestSchema = z.record(z.string(), z.array(z.string()).min(1));

export type PacaPermissionPluginOptions = {
  service?: PacaPermissionService;
  provisionUser?: (userId: string, sessionToken?: string) => Promise<void>;
};

function requireService(service: PacaPermissionService | undefined): PacaPermissionService {
  if (!service) {
    throw new APIError("SERVICE_UNAVAILABLE", {
      message: "Paca permission storage is not available in this auth instance",
    });
  }
  return service;
}

function serializePermissions(grants: PermissionGrant[]) {
  return {
    grants,
    legacyPermissions: Object.fromEntries(
      grants.map((grant) => [toLegacyPermissionKey(grant), true]),
    ),
  };
}

function validatedPermissionRequest(scope: PermissionScope, value: unknown): PermissionRequest {
  try {
    const request = permissionRequestFromUnknown(value);
    validatePermissionRequest(scope, request);
    return request;
  } catch (error) {
    const code = error instanceof Error ? error.message : "PERMISSION_REQUEST_INVALID";
    throw new APIError("BAD_REQUEST", { message: code });
  }
}

export function pacaPermission(options: PacaPermissionPluginOptions = {}) {
  const plugin = {
    id: "paca-permission",
    schema: {
      pacaSystemRole: {
        modelName: "paca_system_role",
        disableMigration: true,
        fields: {
          name: { type: "string", unique: true },
          description: { type: "string", required: false },
          isBuiltIn: { type: "boolean", defaultValue: false },
          createdAt: { type: "date" },
          updatedAt: { type: "date" },
        },
      },
      pacaOrganizationRole: {
        modelName: "paca_organization_role",
        disableMigration: true,
        fields: {
          organizationId: {
            type: "string",
            references: { model: "organization", field: "id", onDelete: "cascade" },
          },
          name: { type: "string" },
          description: { type: "string", required: false },
          isBuiltIn: { type: "boolean", defaultValue: false },
          createdAt: { type: "date" },
          updatedAt: { type: "date" },
        },
      },
      pacaProjectRole: {
        modelName: "paca_project_role",
        disableMigration: true,
        fields: {
          projectId: { type: "string" },
          name: { type: "string" },
          description: { type: "string", required: false },
          isBuiltIn: { type: "boolean", defaultValue: false },
          createdAt: { type: "date" },
          updatedAt: { type: "date" },
        },
      },
    },
    endpoints: {
      hasSystemPermission: createAuthEndpoint(
        "/paca-permission/has-system-permission",
        {
          method: "POST",
          body: z.object({ permissions: permissionRequestSchema }),
          use: [sessionMiddleware],
        },
        async (context) => {
          const permissions = validatedPermissionRequest("system", context.body.permissions);
          const decision = await requireService(options.service).hasSystemPermission(
            context.context.session.user.id,
            permissions,
          );
          return context.json({ allowed: decision.allowed });
        },
      ),
      hasOrganizationPermission: createAuthEndpoint(
        "/paca-permission/has-organization-permission",
        {
          method: "POST",
          body: z.object({
            organizationId: z.string().min(1),
            permissions: permissionRequestSchema,
          }),
          use: [sessionMiddleware],
        },
        async (context) => {
          const permissions = validatedPermissionRequest("organization", context.body.permissions);
          const decision = await requireService(options.service).hasOrganizationPermission(
            context.context.session.user.id,
            context.body.organizationId,
            permissions,
          );
          return context.json({ allowed: decision.allowed });
        },
      ),
      hasProjectPermission: createAuthEndpoint(
        "/paca-permission/has-project-permission",
        {
          method: "POST",
          body: z.object({
            projectId: z.uuid(),
            permissions: permissionRequestSchema,
          }),
          use: [sessionMiddleware],
        },
        async (context) => {
          const permissions = validatedPermissionRequest("project", context.body.permissions);
          const decision = await requireService(options.service).hasProjectPermission(
            context.context.session.user.id,
            context.body.projectId,
            permissions,
          );
          return context.json({ allowed: decision.allowed });
        },
      ),
      listSystemPermissions: createAuthEndpoint(
        "/paca-permission/list-system-permissions",
        { method: "GET", use: [sessionMiddleware] },
        async (context) => {
          const grants = await requireService(options.service).listSystemPermissions(
            context.context.session.user.id,
          );
          return context.json(serializePermissions(grants));
        },
      ),
      listOrganizationPermissions: createAuthEndpoint(
        "/paca-permission/list-organization-permissions",
        {
          method: "GET",
          query: z.object({ organizationId: z.string().min(1) }),
          use: [sessionMiddleware],
        },
        async (context) => {
          const grants = await requireService(options.service).listOrganizationPermissions(
            context.context.session.user.id,
            context.query.organizationId,
          );
          if (!grants) throw new APIError("NOT_FOUND", { message: "Organization not found" });
          return context.json(serializePermissions(grants));
        },
      ),
      listProjectPermissions: createAuthEndpoint(
        "/paca-permission/list-project-permissions",
        {
          method: "GET",
          query: z.object({ projectId: z.uuid() }),
          use: [sessionMiddleware],
        },
        async (context) => {
          const grants = await requireService(options.service).listProjectPermissions(
            context.context.session.user.id,
            context.query.projectId,
          );
          if (!grants) throw new APIError("NOT_FOUND", { message: "Project not found" });
          return context.json(serializePermissions(grants));
        },
      ),
    },
    hooks: {
      after: [
        {
          matcher: (context) =>
            context.path === "/sign-up/email" || context.path === "/sign-in/email",
          handler: createAuthMiddleware(async (context) => {
            const newSession = context.context.newSession;
            if (!newSession || !options.provisionUser) return;
            await options.provisionUser(newSession.user.id, newSession.session.token);
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;

  return plugin;
}
