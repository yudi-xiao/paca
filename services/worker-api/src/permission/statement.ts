export const pacaPermissionStatement = {
  users: ["read", "write", "delete"],
  globalRoles: ["read", "write", "assign"],
  projects: ["read", "write", "create", "delete"],
  organizationMembers: ["read", "write"],
  organizationRoles: ["read", "write"],
  projectMembers: ["read", "write"],
  projectRoles: ["read", "write"],
  tasks: ["read", "write"],
  sprints: ["read", "write"],
  docs: ["read", "write"],
  agents: ["read", "write", "approveGrant"],
  environments: ["read", "write", "connect"],
  workflows: ["read", "write", "execute"],
  settings: ["write"],
} as const;

export type PermissionResource = keyof typeof pacaPermissionStatement;
export type PermissionAction<R extends PermissionResource = PermissionResource> =
  (typeof pacaPermissionStatement)[R][number];

export type PermissionRequest = Partial<{
  [R in PermissionResource]: readonly PermissionAction<R>[];
}>;

export type PermissionGrant = {
  resource: PermissionResource | "*";
  action: string;
};

export type PermissionScope = "system" | "organization" | "project";
type PermissionGrantScope = PermissionScope | "systemRole";

const scopeResources = {
  system: ["users", "globalRoles", "projects", "agents", "settings"],
  organization: ["projects", "organizationMembers", "organizationRoles", "agents", "workflows"],
  project: [
    "projects",
    "projectMembers",
    "projectRoles",
    "tasks",
    "sprints",
    "docs",
    "agents",
    "environments",
    "workflows",
  ],
} as const satisfies Record<PermissionScope, readonly PermissionResource[]>;

const legacyResourceNames: Record<PermissionResource, string> = {
  users: "users",
  globalRoles: "global_roles",
  projects: "projects",
  organizationMembers: "organization.members",
  organizationRoles: "organization.roles",
  projectMembers: "project.members",
  projectRoles: "project.roles",
  tasks: "tasks",
  sprints: "sprints",
  docs: "docs",
  agents: "agents",
  environments: "environments",
  workflows: "workflows",
  settings: "settings",
};

const permissionResourcesByLegacyName = new Map(
  Object.entries(legacyResourceNames).map(([resource, legacyName]) => [
    legacyName,
    resource as PermissionResource,
  ]),
);

export function isPermissionResource(value: string): value is PermissionResource {
  return Object.hasOwn(pacaPermissionStatement, value);
}

export function isPermissionAction<R extends PermissionResource>(
  resource: R,
  action: string,
): action is PermissionAction<R> {
  return (pacaPermissionStatement[resource] as readonly string[]).includes(action);
}

export function isResourceAllowedInScope(
  scope: PermissionScope,
  resource: PermissionResource,
): boolean {
  return (scopeResources[scope] as readonly PermissionResource[]).includes(resource);
}

function isResourceAllowedForGrantScope(
  scope: PermissionGrantScope,
  resource: PermissionResource,
): boolean {
  // A system role is inherited into organization/project decisions, so it may
  // deliberately carry any reviewed Paca permission. This differs from a
  // system-scoped API authorization request, which remains limited to the
  // instance-level resources above.
  return scope === "systemRole" || isResourceAllowedInScope(scope, resource);
}

export function validatePermissionRequest(
  scope: PermissionScope,
  request: PermissionRequest,
): PermissionGrant[] {
  const grants: PermissionGrant[] = [];

  for (const [resourceValue, actionsValue] of Object.entries(request)) {
    if (!isPermissionResource(resourceValue)) {
      throw new Error("PERMISSION_RESOURCE_INVALID");
    }
    if (!isResourceAllowedInScope(scope, resourceValue)) {
      throw new Error("PERMISSION_RESOURCE_SCOPE_INVALID");
    }
    if (!Array.isArray(actionsValue) || actionsValue.length === 0) {
      throw new Error("PERMISSION_ACTIONS_EMPTY");
    }

    const uniqueActions = new Set(actionsValue);
    for (const action of uniqueActions) {
      if (typeof action !== "string" || !isPermissionAction(resourceValue, action)) {
        throw new Error("PERMISSION_ACTION_INVALID");
      }
      grants.push({ resource: resourceValue, action });
    }
  }

  if (grants.length === 0) {
    throw new Error("PERMISSION_REQUEST_EMPTY");
  }

  return grants;
}

export function toLegacyPermissionKey(grant: PermissionGrant): string {
  if (grant.resource === "*") {
    return "*";
  }
  return `${legacyResourceNames[grant.resource]}.${grant.action}`;
}

export function permissionGrantsFromLegacyMap(
  scope: PermissionGrantScope,
  value: unknown,
): PermissionGrant[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("PERMISSION_MAP_INVALID");
  }

  const grants: PermissionGrant[] = [];
  for (const [key, enabled] of Object.entries(value)) {
    if (typeof enabled !== "boolean") {
      throw new Error("PERMISSION_MAP_VALUE_INVALID");
    }
    if (!enabled) continue;

    if (key === "*") {
      if (scope !== "system" && scope !== "systemRole") {
        throw new Error("PERMISSION_RESOURCE_SCOPE_INVALID");
      }
      grants.push({ resource: "*", action: "*" });
      continue;
    }

    const separator = key.lastIndexOf(".");
    if (separator <= 0 || separator === key.length - 1) {
      throw new Error("PERMISSION_KEY_INVALID");
    }

    const legacyResource = key.slice(0, separator);
    const action = key.slice(separator + 1);
    const resource = permissionResourcesByLegacyName.get(legacyResource);
    if (!resource) throw new Error("PERMISSION_RESOURCE_INVALID");
    if (!isResourceAllowedForGrantScope(scope, resource)) {
      throw new Error("PERMISSION_RESOURCE_SCOPE_INVALID");
    }
    if (action !== "*" && !isPermissionAction(resource, action)) {
      throw new Error("PERMISSION_ACTION_INVALID");
    }

    grants.push({ resource, action });
  }

  return grants;
}

export function permissionGrantsToLegacyMap(
  grants: readonly PermissionGrant[],
): Record<string, boolean> {
  return Object.fromEntries(grants.map((grant) => [toLegacyPermissionKey(grant), true]));
}

export function permissionRequestFromUnknown(value: unknown): PermissionRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("PERMISSION_REQUEST_INVALID");
  }
  return value as PermissionRequest;
}
