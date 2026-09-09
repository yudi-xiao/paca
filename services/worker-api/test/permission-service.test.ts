import { describe, expect, it, vi } from "vitest";

import { PacaPermissionService, type PacaPermissionStore } from "../src/permission/service";
import type { PermissionGrant } from "../src/permission/statement";

function fakeStore(overrides: Partial<PacaPermissionStore> = {}): PacaPermissionStore {
  return {
    listSystemGrants: async () => [],
    listOrganizationGrants: async () => [],
    listProjectGrants: async () => [],
    organizationExists: async () => true,
    findProjectOrganization: async () => "organization-1",
    ...overrides,
  };
}

describe("PacaPermissionService", () => {
  it("honors global wildcards for every system permission", async () => {
    const service = new PacaPermissionService(
      fakeStore({ listSystemGrants: async () => [{ resource: "*", action: "*" }] }),
    );

    await expect(
      service.hasSystemPermission("user-1", { settings: ["write"], users: ["delete"] }),
    ).resolves.toMatchObject({ allowed: true, scopeExists: true });
  });

  it("combines system, organization, and project grants without duplicates", async () => {
    const service = new PacaPermissionService(
      fakeStore({
        listSystemGrants: async () => [{ resource: "projects", action: "read" }],
        listOrganizationGrants: async () => [{ resource: "workflows", action: "execute" }],
        listProjectGrants: async () => [
          { resource: "tasks", action: "write" },
          { resource: "projects", action: "read" },
        ],
      }),
    );

    await expect(service.listProjectPermissions("user-1", "project-1")).resolves.toEqual([
      { resource: "projects", action: "read" },
      { resource: "tasks", action: "write" },
      { resource: "workflows", action: "execute" },
    ] satisfies PermissionGrant[]);
  });

  it("keeps project roles isolated per project", async () => {
    const listProjectGrants = vi.fn(async (_userId: string, projectId: string) =>
      projectId === "project-a"
        ? ([{ resource: "docs", action: "write" }] satisfies PermissionGrant[])
        : [],
    );
    const service = new PacaPermissionService(fakeStore({ listProjectGrants }));

    await expect(
      service.hasProjectPermission("user-1", "project-a", { docs: ["write"] }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      service.hasProjectPermission("user-1", "project-b", { docs: ["write"] }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it("evaluates bulk project grant sets through the same permission semantics", async () => {
    const service = new PacaPermissionService(
      fakeStore({
        listProjectGrantSets: async () =>
          new Map([
            ["project-a", [{ resource: "tasks", action: "read" }]],
            ["project-b", [{ resource: "docs", action: "read" }]],
          ]),
      }),
    );

    const decisions = await service.hasProjectPermissions(
      "user-1",
      ["project-a", "project-b", "missing"],
      { tasks: ["read"] },
    );
    expect(decisions.get("project-a")).toMatchObject({ allowed: true, scopeExists: true });
    expect(decisions.get("project-b")).toMatchObject({ allowed: false, scopeExists: true });
    expect(decisions.get("missing")).toEqual({ allowed: false, grants: [], scopeExists: false });
  });

  it("uses the bulk multi-user project permission authority without changing grant semantics", async () => {
    const listProjectGrantSetsForUsers = vi.fn(async () =>
      Promise.resolve(
        new Map([
          ["user-1", [{ resource: "environments", action: "connect" }]],
          ["user-2", [{ resource: "environments", action: "read" }]],
        ] satisfies Array<[string, PermissionGrant[]]>),
      ),
    );
    const service = new PacaPermissionService(fakeStore({ listProjectGrantSetsForUsers }));

    const permissions = await service.listProjectPermissionsForUsers(
      ["user-1", "user-2", "user-1"],
      "project-1",
    );
    expect(permissions).toEqual(
      new Map([
        ["user-1", [{ resource: "environments", action: "connect" }]],
        ["user-2", [{ resource: "environments", action: "read" }]],
      ]),
    );
    expect(listProjectGrantSetsForUsers).toHaveBeenCalledWith(["user-1", "user-2"], "project-1");
  });

  it("marks every user outside a missing project scope as unavailable", async () => {
    const service = new PacaPermissionService(
      fakeStore({ listProjectGrantSetsForUsers: async () => null }),
    );

    await expect(
      service.listProjectPermissionsForUsers(["user-1", "user-2"], "missing"),
    ).resolves.toEqual(
      new Map([
        ["user-1", null],
        ["user-2", null],
      ]),
    );
  });

  it("does not treat an unknown project as an authorization success", async () => {
    const service = new PacaPermissionService(
      fakeStore({ findProjectOrganization: async () => null }),
    );

    await expect(
      service.hasProjectPermission("user-1", "missing", { projects: ["read"] }),
    ).resolves.toEqual({ allowed: false, grants: [], scopeExists: false });
  });

  it("does not treat an unknown organization as an authorization scope", async () => {
    const listOrganizationGrants = vi.fn(async () => []);
    const service = new PacaPermissionService(
      fakeStore({ organizationExists: async () => false, listOrganizationGrants }),
    );

    await expect(
      service.hasOrganizationPermission("user-1", "missing", {
        organizationRoles: ["read"],
      }),
    ).resolves.toEqual({ allowed: false, grants: [], scopeExists: false });

    await expect(service.listOrganizationPermissions("user-1", "missing")).resolves.toBeNull();
    expect(listOrganizationGrants).not.toHaveBeenCalled();
  });

  it("rejects resources that do not belong to the requested scope before storage access", async () => {
    const listSystemGrants = vi.fn(async () => []);
    const service = new PacaPermissionService(fakeStore({ listSystemGrants }));

    await expect(service.hasSystemPermission("user-1", { tasks: ["read"] })).rejects.toThrowError(
      "PERMISSION_RESOURCE_SCOPE_INVALID",
    );
    expect(listSystemGrants).not.toHaveBeenCalled();
  });
});
