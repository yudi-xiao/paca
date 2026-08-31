import { hasEveryPermission, uniquePermissionGrants } from "./evaluator";
import type { PermissionGrant, PermissionRequest } from "./statement";
import { validatePermissionRequest } from "./statement";

export interface PacaPermissionStore {
  listSystemGrants(userId: string): Promise<PermissionGrant[]>;
  listOrganizationGrants(userId: string, organizationId: string): Promise<PermissionGrant[]>;
  listProjectGrants(userId: string, projectId: string): Promise<PermissionGrant[]>;
  organizationExists(organizationId: string): Promise<boolean>;
  findProjectOrganization(projectId: string): Promise<string | null>;
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
    const [system, organization] = await Promise.all([
      this.store.listSystemGrants(userId),
      this.store.listOrganizationGrants(userId, organizationId),
    ]);
    return uniquePermissionGrants([...system, ...organization]);
  }

  async listProjectPermissions(
    userId: string,
    projectId: string,
  ): Promise<PermissionGrant[] | null> {
    const organizationId = await this.store.findProjectOrganization(projectId);
    if (!organizationId) return null;

    const [system, organization, project] = await Promise.all([
      this.store.listSystemGrants(userId),
      this.store.listOrganizationGrants(userId, organizationId),
      this.store.listProjectGrants(userId, projectId),
    ]);
    return uniquePermissionGrants([...system, ...organization, ...project]);
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
}
