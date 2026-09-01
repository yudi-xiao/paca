import { describe, expect, it, vi } from "vitest";

import type { PermissionGrant } from "../src/permission/statement";
import {
  type PersistedProjectRoleInput,
  type ProjectAccessError,
  type ProjectAccessRepository,
  ProjectAccessService,
  type ProjectMember,
  type ProjectRole,
  projectAccessErrorCodes,
} from "../src/project/access-service";

const projectId = "6bdb7f3a-e59d-4826-8383-0104192157a8";
const role: ProjectRole = {
  id: "4fb5db43-8288-4e11-afca-65bdad55a49d",
  projectId,
  name: "Maintainer",
  description: "Maintains tasks",
  isBuiltIn: false,
  grants: [{ resource: "tasks", action: "write" }],
  createdAt: new Date("2026-08-28T00:00:00.000Z"),
  updatedAt: new Date("2026-08-28T00:00:00.000Z"),
};
const member: ProjectMember = {
  id: "1db7c6ec-189e-407c-91e8-f32d0e46c529",
  projectId,
  userId: "user-2",
  userName: "Member",
  userEmail: "member@example.com",
  userImage: null,
  role,
  createdAt: new Date("2026-08-28T00:00:00.000Z"),
};

function repository(overrides: Partial<ProjectAccessRepository> = {}): ProjectAccessRepository {
  return {
    listRoles: async () => [role],
    createRole: async () => role,
    updateRole: async () => role,
    deleteRole: async () => undefined,
    listMembers: async () => [member],
    addMember: async (_projectId, _userId, _roleId, assertAssignable) => {
      assertAssignable(role);
      return member;
    },
    replaceMemberRole: async (_projectId, _memberId, _roleId, assertAssignable) => {
      assertAssignable(role);
      return member;
    },
    removeMember: async () => ({ userId: member.userId }),
    listUsers: async (_page, _pageSize) => ({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    }),
    ...overrides,
  };
}

describe("project access service", () => {
  it("normalizes a dynamic role and parses the legacy permission map", async () => {
    const createRole = vi.fn(async (_projectId: string, _input: PersistedProjectRoleInput) => role);
    const service = new ProjectAccessService(repository({ createRole }));
    const actorGrants: PermissionGrant[] = [{ resource: "tasks", action: "*" }];

    await service.createRole(actorGrants, projectId, {
      name: "  Maintainer  ",
      description: "  Maintains tasks  ",
      permissions: { "tasks.write": true, "docs.read": false },
    });

    expect(createRole).toHaveBeenCalledWith(projectId, {
      name: "Maintainer",
      description: "Maintains tasks",
      grants: [{ resource: "tasks", action: "write" }],
    });
  });

  it("rejects malformed permission maps", async () => {
    const service = new ProjectAccessService(repository());

    await expect(
      service.createRole([{ resource: "tasks", action: "*" }], projectId, {
        name: "Maintainer",
        permissions: { "unknown.write": true },
      }),
    ).rejects.toMatchObject({
      code: projectAccessErrorCodes.permissionsInvalid,
    } satisfies Partial<ProjectAccessError>);
  });

  it("prevents role creation and assignment above the actor grant ceiling", async () => {
    const service = new ProjectAccessService(repository());
    const actorGrants: PermissionGrant[] = [{ resource: "tasks", action: "read" }];

    await expect(
      service.createRole(actorGrants, projectId, {
        name: "Writer",
        permissions: { "tasks.write": true },
      }),
    ).rejects.toMatchObject({
      code: projectAccessErrorCodes.permissionEscalation,
    } satisfies Partial<ProjectAccessError>);
    await expect(
      service.addMember(actorGrants, projectId, "user-2", role.id),
    ).rejects.toMatchObject({
      code: projectAccessErrorCodes.permissionEscalation,
    } satisfies Partial<ProjectAccessError>);
  });

  it("clamps directory pagination", async () => {
    const listUsers = vi.fn(async (page: number, pageSize: number) => ({
      items: [],
      total: 0,
      page,
      pageSize,
    }));
    const service = new ProjectAccessService(repository({ listUsers }));

    await service.listUsers(-1, 999);
    expect(listUsers).toHaveBeenCalledWith(1, 100);
  });
});
