import { describe, expect, it, vi } from "vitest";
import {
  type OrganizationAccessError,
  type OrganizationAccessRepository,
  OrganizationAccessService,
  type OrganizationMember,
  type OrganizationRole,
  organizationAccessErrorCodes,
  type PersistedOrganizationRoleInput,
} from "../src/organization/access-service";
import type { PermissionGrant } from "../src/permission/statement";

const organizationId = "paca-default";
const role: OrganizationRole = {
  id: "4fb5db43-8288-4e11-afca-65bdad55a49d",
  organizationId,
  name: "Project creator",
  description: "Can create projects",
  isBuiltIn: false,
  grants: [{ resource: "projects", action: "create" }],
  createdAt: new Date("2026-08-28T00:00:00.000Z"),
  updatedAt: new Date("2026-08-28T00:00:00.000Z"),
};
const member: OrganizationMember = {
  id: "member-2",
  organizationId,
  userId: "user-2",
  userName: "Member",
  userEmail: "member@example.com",
  userImage: null,
  roles: [role],
  createdAt: new Date("2026-08-28T00:00:00.000Z"),
};

function repository(
  overrides: Partial<OrganizationAccessRepository> = {},
): OrganizationAccessRepository {
  return {
    listRoles: async () => [role],
    createRole: async () => role,
    updateRole: async () => role,
    deleteRole: async () => undefined,
    listMembers: async () => [member],
    replaceMemberRoles: async (_organizationId, _memberId, _roleIds, assertAssignable) => {
      assertAssignable([role]);
      return member;
    },
    ...overrides,
  };
}

describe("organization access service", () => {
  it("normalizes organization roles and parses scoped permissions", async () => {
    const createRole = vi.fn(
      async (_organizationId: string, _input: PersistedOrganizationRoleInput) => role,
    );
    const service = new OrganizationAccessService(repository({ createRole }));

    await service.createRole([{ resource: "projects", action: "*" }], organizationId, {
      name: "  Project creator  ",
      description: "  Can create projects  ",
      permissions: { "projects.create": true, "projects.delete": false },
    });

    expect(createRole).toHaveBeenCalledWith(organizationId, {
      name: "Project creator",
      description: "Can create projects",
      grants: [{ resource: "projects", action: "create" }],
    });
  });

  it("rejects project-scoped permission resources in organization roles", async () => {
    const service = new OrganizationAccessService(repository());

    await expect(
      service.createRole([{ resource: "*", action: "*" }], organizationId, {
        name: "Task writer",
        permissions: { "tasks.write": true },
      }),
    ).rejects.toMatchObject({
      code: organizationAccessErrorCodes.permissionsInvalid,
    } satisfies Partial<OrganizationAccessError>);
  });

  it("enforces the actor grant ceiling for role creation and assignment", async () => {
    const actorGrants: PermissionGrant[] = [{ resource: "projects", action: "read" }];
    const service = new OrganizationAccessService(repository());

    await expect(
      service.createRole(actorGrants, organizationId, {
        name: "Project creator",
        permissions: { "projects.create": true },
      }),
    ).rejects.toMatchObject({
      code: organizationAccessErrorCodes.permissionEscalation,
    } satisfies Partial<OrganizationAccessError>);
    await expect(
      service.replaceMemberRoles(actorGrants, organizationId, member.id, [role.id]),
    ).rejects.toMatchObject({
      code: organizationAccessErrorCodes.permissionEscalation,
    } satisfies Partial<OrganizationAccessError>);
  });

  it("deduplicates a bounded multi-role assignment", async () => {
    const replaceMemberRoles = vi.fn(
      async (
        _organizationId: string,
        _memberId: string,
        _roleIds: readonly string[],
        assertAssignable: (roles: readonly OrganizationRole[]) => void,
      ) => {
        assertAssignable([role]);
        return member;
      },
    );
    const service = new OrganizationAccessService(repository({ replaceMemberRoles }));

    await service.replaceMemberRoles(
      [{ resource: "projects", action: "*" }],
      organizationId,
      member.id,
      [role.id, role.id],
    );

    expect(replaceMemberRoles).toHaveBeenCalledWith(
      organizationId,
      member.id,
      [role.id],
      expect.any(Function),
    );
  });
});
