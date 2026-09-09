import { hasEveryPermission, uniquePermissionGrants } from "./evaluator";
import type { PermissionGrant, PermissionRequest } from "./statement";
import { validatePermissionRequest } from "./statement";

export interface PacaPermissionStore {
  listSystemGrants(userId: string): Promise<PermissionGrant[]>;
  listOrganizationGrants(userId: string, organizationId: string): Promise<PermissionGrant[]>;
  listProjectGrants(userId: string, projectId: string): Promise<PermissionGrant[]>;
  organizationExists(organizationId: string): Promise<boolean>;
  findProjectOrganization(projectId: string): Promise<string | null>;
  listProjectGrantSets?(
    userId: string,
    projectIds: string[],
  ): Promise<Map<string, PermissionGrant[]>>;
  listProjectGrantSetsForUsers?(
    userIds: string[],
    projectId: string,
  ): Promise<Map<string, PermissionGrant[]> | null>;
}

export type PermissionDecision = {
  allowed: boolean;
  grants: PermissionGrant[];
  scopeExists: boolean;
};

export class PacaPermissionService {
  constructor(private readonly store: PacaPermissionStore) {}

  async listSystemPermissions(userId: string): Promise<PermissionGrant[]> {
    return uniquePermissionGrants(await this.store.listSystemGrants(userId));
  }

  async listOrganizationPermissions(
    userId: string,
    organizationId: string,
  ): Promise<PermissionGrant[] | null> {
    if (!(await this.store.organizationExists(organizationId))) return null;
    // Runtime repositories share one request-scoped pg.Client. Keep reads
    // sequential: pg 9 removes concurrent client.query() calls.
    const system = await this.store.listSystemGrants(userId);
    const organization = await this.store.listOrganizationGrants(userId, organizationId);
    return uniquePermissionGrants([...system, ...organization]);
  }

  async listProjectPermissions(
    userId: string,
    projectId: string,
  ): Promise<PermissionGrant[] | null> {
    const organizationId = await this.store.findProjectOrganization(projectId);
    if (!organizationId) return null;

    const system = await this.store.listSystemGrants(userId);
    const organization = await this.store.listOrganizationGrants(userId, organizationId);
    const project = await this.store.listProjectGrants(userId, projectId);
    return uniquePermissionGrants([...system, ...organization, ...project]);
  }

  async listProjectPermissionsForUsers(
    userIds: string[],
    projectId: string,
  ): Promise<Map<string, PermissionGrant[] | null>> {
    const uniqueUserIds = [...new Set(userIds)];
    if (this.store.listProjectGrantSetsForUsers) {
      const grantSets = await this.store.listProjectGrantSetsForUsers(uniqueUserIds, projectId);
      return new Map(
        uniqueUserIds.map((userId) => [
          userId,
          grantSets ? uniquePermissionGrants(grantSets.get(userId) ?? []) : null,
        ]),
      );
    }
    const result = new Map<string, PermissionGrant[] | null>();
    for (const userId of uniqueUserIds) {
      result.set(userId, await this.listProjectPermissions(userId, projectId));
    }
    return result;
  }

  async hasSystemPermission(
    userId: string,
    request: PermissionRequest,
  ): Promise<PermissionDecision> {
    const required = validatePermissionRequest("system", request);
    const grants = await this.listSystemPermissions(userId);
    return { allowed: hasEveryPermission(grants, required), grants, scopeExists: true };
  }

  async hasOrganizationPermission(
    userId: string,
    organizationId: string,
    request: PermissionRequest,
  ): Promise<PermissionDecision> {
    const required = validatePermissionRequest("organization", request);
    const grants = await this.listOrganizationPermissions(userId, organizationId);
    if (!grants) return { allowed: false, grants: [], scopeExists: false };
    return { allowed: hasEveryPermission(grants, required), grants, scopeExists: true };
  }

  async hasProjectPermission(
    userId: string,
    projectId: string,
    request: PermissionRequest,
  ): Promise<PermissionDecision> {
    const required = validatePermissionRequest("project", request);
    const grants = await this.listProjectPermissions(userId, projectId);
    if (!grants) {
      return { allowed: false, grants: [], scopeExists: false };
    }
    return { allowed: hasEveryPermission(grants, required), grants, scopeExists: true };
  }

  async hasProjectPermissions(
    userId: string,
    projectIds: string[],
    request: PermissionRequest,
  ): Promise<Map<string, PermissionDecision>> {
    const required = validatePermissionRequest("project", request);
    if (this.store.listProjectGrantSets) {
      const grantSets = await this.store.listProjectGrantSets(userId, projectIds);
      return new Map(
        projectIds.map((projectId) => {
          const grants = grantSets.get(projectId);
          return [
            projectId,
            grants
              ? {
                  allowed: hasEveryPermission(grants, required),
                  grants: uniquePermissionGrants(grants),
                  scopeExists: true,
                }
              : { allowed: false, grants: [], scopeExists: false },
          ];
        }),
      );
    }
    const decisions = new Map<string, PermissionDecision>();
    for (const projectId of projectIds) {
      decisions.set(projectId, await this.hasProjectPermission(userId, projectId, request));
    }
    return decisions;
  }
}
