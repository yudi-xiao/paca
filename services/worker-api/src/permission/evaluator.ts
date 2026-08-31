import {
  type PermissionGrant,
  type PermissionResource,
  pacaPermissionStatement,
} from "./statement";

function grantMatches(granted: PermissionGrant, required: PermissionGrant): boolean {
  const resourceMatches = granted.resource === "*" || granted.resource === required.resource;
  const actionMatches = granted.action === "*" || granted.action === required.action;
  return resourceMatches && actionMatches;
}

export function hasEveryPermission(
  granted: readonly PermissionGrant[],
  required: readonly PermissionGrant[],
): boolean {
  return required.every((permission) =>
    granted.some((candidate) => grantMatches(candidate, permission)),
  );
}

export function uniquePermissionGrants(grants: readonly PermissionGrant[]): PermissionGrant[] {
  const seen = new Set<string>();
  const unique: PermissionGrant[] = [];

  for (const grant of grants) {
    const key = `${grant.resource}:${grant.action}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(grant);
  }

  return unique.sort((left, right) => {
    const resourceOrder = left.resource.localeCompare(right.resource);
    return resourceOrder === 0 ? left.action.localeCompare(right.action) : resourceOrder;
  });
}

export function canDelegatePermissionGrants(
  actorGrants: readonly PermissionGrant[],
  proposedGrants: readonly PermissionGrant[],
): boolean {
  const required: PermissionGrant[] = [];

  for (const grant of proposedGrants) {
    if (grant.resource === "*") {
      // A global wildcard is stronger than the finite statement because it
      // automatically covers future resources. Only an actor who already has
      // that exact global wildcard may delegate it.
      if (!hasEveryPermission(actorGrants, [{ resource: "*", action: "*" }])) {
        return false;
      }
      continue;
    }

    if (grant.action === "*") {
      required.push(
        ...pacaPermissionStatement[grant.resource].map((action) => ({
          resource: grant.resource as PermissionResource,
          action,
        })),
      );
      continue;
    }

    required.push(grant);
  }

  return hasEveryPermission(actorGrants, required);
}
