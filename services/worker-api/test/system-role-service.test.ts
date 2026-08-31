import { describe, expect, it, vi } from "vitest";

import type { PermissionGrant } from "../src/permission/statement";
import {
  type PersistedSystemRoleInput,
  type SystemRole,
  SystemRoleError,
  type SystemRoleRepository,
  SystemRoleService,
  systemRoleErrorCodes,
} from "../src/permission/system-role-service";

const now = new Date("2026-08-28T00:00:00.000Z");
const systemRoleFixtureId = "4fb5db43-8288-4e11-afca-65bdad55a49d";

function role(overrides: Partial<SystemRole> = {}): SystemRole {
  return {
    id: systemRoleFixtureId,
    name: "Maintainer",
    description: "Maintains users",
    isBuiltIn: false,
    grants: [{ resource: "users", action: "read" }],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function fakeRepository(overrides: Partial<SystemRoleRepository> = {}): SystemRoleRepository {
  return {
    list: async () => [],
    create: async (input) => role({ ...input }),
    update: async (id, input) => role({ id, ...input }),
    delete: async () => undefined,
    replaceUserRoles: async (_userId, _roleIds, assertAssignable) => {
      const roles = [role()];
      assertAssignable(roles);
      return roles;
    },
    ...overrides,
  };
}

describe("SystemRoleService", () => {
  it("normalizes role input and persists only validated system grants", async () => {
    const create = vi.fn(async (input: PersistedSystemRoleInput) => role({ ...input }));
    const service = new SystemRoleService(fakeRepository({ create }));
    const actor = [{ resource: "users", action: "*" }] satisfies PermissionGrant[];

    await service.create(actor, {
      name: "  Support  ",
      description: "  Reads users  ",
      permissions: { "users.read": true, "users.write": false },
    });

    expect(create).toHaveBeenCalledWith({
      name: "Support",
      description: "Reads users",
      grants: [{ resource: "users", action: "read" }],
    });
  });

  it("accepts project permissions inherited by every project", async () => {
    const create = vi.fn(async (input: PersistedSystemRoleInput) => role({ ...input }));
    const service = new SystemRoleService(fakeRepository({ create }));

    await service.create([{ resource: "tasks", action: "write" }], {
      name: "Project Maintainer",
      permissions: { "tasks.write": true },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ grants: [{ resource: "tasks", action: "write" }] }),
    );
  });

  it("rejects malformed permission maps", async () => {
    const service = new SystemRoleService(fakeRepository());

    await expect(
      service.create([{ resource: "*", action: "*" }], {
        name: "Maintainer",
        permissions: { "tasks.fly": true },
      }),
    ).rejects.toMatchObject({ code: systemRoleErrorCodes.permissionsInvalid });
  });

  it("prevents a role manager from granting permissions they do not hold", async () => {
    const create = vi.fn();
    const service = new SystemRoleService(fakeRepository({ create }));

    await expect(
      service.create([{ resource: "users", action: "read" }], {
        name: "User Writer",
        permissions: { "users.write": true },
      }),
    ).rejects.toMatchObject({ code: systemRoleErrorCodes.permissionEscalation });
    expect(create).not.toHaveBeenCalled();
  });

  it("allows a super administrator to create a future-proof wildcard role", async () => {
    const create = vi.fn(async (input: PersistedSystemRoleInput) => role({ ...input }));
    const service = new SystemRoleService(fakeRepository({ create }));

    await service.create([{ resource: "*", action: "*" }], {
      name: "Emergency Admin",
      permissions: { "*": true },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ grants: [{ resource: "*", action: "*" }] }),
    );
  });

  it("preserves repository domain errors for built-ins and assignments", async () => {
    const service = new SystemRoleService(
      fakeRepository({
        delete: async () => {
          throw new SystemRoleError(systemRoleErrorCodes.builtIn);
        },
      }),
    );

    await expect(service.delete("role-1")).rejects.toMatchObject({
      code: systemRoleErrorCodes.builtIn,
    });
  });

  it("normalizes duplicate assignments and applies the grant ceiling inside the repository unit", async () => {
    const replaceUserRoles = vi.fn(
      async (
        _userId: string,
        _roleIds: readonly string[],
        assertAssignable: (roles: readonly SystemRole[]) => void,
      ) => {
        const roles = [role({ grants: [{ resource: "users", action: "read" }] })];
        assertAssignable(roles);
        return roles;
      },
    );
    const service = new SystemRoleService(fakeRepository({ replaceUserRoles }));

    await service.replaceUserRoles([{ resource: "users", action: "read" }], " user-1 ", [
      systemRoleFixtureId,
      systemRoleFixtureId,
    ]);

    expect(replaceUserRoles).toHaveBeenCalledWith(
      "user-1",
      [systemRoleFixtureId],
      expect.any(Function),
    );
  });

  it("rejects empty assignment sets before storage access", async () => {
    const replaceUserRoles = vi.fn();
    const service = new SystemRoleService(fakeRepository({ replaceUserRoles }));

    await expect(service.replaceUserRoles([], "user-1", [])).rejects.toMatchObject({
      code: systemRoleErrorCodes.assignmentInvalid,
    });
    expect(replaceUserRoles).not.toHaveBeenCalled();
  });

  it("rejects assignment of a role above the actor's grant ceiling", async () => {
    const service = new SystemRoleService(
      fakeRepository({
        replaceUserRoles: async (_userId, _roleIds, assertAssignable) => {
          const roles = [role({ grants: [{ resource: "users", action: "write" }] })];
          assertAssignable(roles);
          return roles;
        },
      }),
    );

    await expect(
      service.replaceUserRoles([{ resource: "users", action: "read" }], "user-1", [
        systemRoleFixtureId,
      ]),
    ).rejects.toMatchObject({ code: systemRoleErrorCodes.permissionEscalation });
  });
});
