import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import type { AppBindings } from "../src/bindings";
import type { OrganizationAccessRuntime } from "../src/organization/access-runtime";
import type { OrganizationMember, OrganizationRole } from "../src/organization/access-service";
import type { PermissionGrant } from "../src/permission/statement";
import type { SystemRoleRuntime } from "../src/permission/system-role-runtime";
import {
  type SystemRole,
  SystemRoleError,
  systemRoleErrorCodes,
} from "../src/permission/system-role-service";
import type { ProjectAccessRuntime } from "../src/project/access-runtime";
import type { ProjectMember, ProjectRole } from "../src/project/access-service";
import type { ProjectRuntime } from "../src/project/runtime";
import type { Project } from "../src/project/service";

function testBindings(overrides: Partial<AppBindings> = {}): AppBindings {
  return {
    ENVIRONMENT: "test",
    ...overrides,
  } as AppBindings;
}

const systemRoleFixture: SystemRole = {
  id: "4fb5db43-8288-4e11-afca-65bdad55a49d",
  name: "Maintainer",
  description: "Maintains users",
  isBuiltIn: false,
  grants: [{ resource: "users", action: "read" }],
  createdAt: new Date("2026-08-28T00:00:00.000Z"),
  updatedAt: new Date("2026-08-28T00:00:00.000Z"),
};

const projectFixture: Project = {
  id: "6bdb7f3a-e59d-4826-8383-0104192157a8",
  organizationId: "paca-default",
  name: "Cloudflare migration",
  description: "Internal preview project",
  taskIdPrefix: "CF",
  isPublic: false,
  settings: {},
  createdBy: "user-1",
  createdAt: new Date("2026-08-28T00:00:00.000Z"),
  updatedAt: new Date("2026-08-28T00:00:00.000Z"),
};

const organizationRoleFixture: OrganizationRole = {
  id: "d177b9cf-b561-4a55-9672-f3190d9d6ea4",
  organizationId: "paca-default",
  name: "OWNER",
  description: "Organization owner",
  isBuiltIn: true,
  grants: [{ resource: "organizationRoles", action: "write" }],
  createdAt: new Date("2026-08-28T00:00:00.000Z"),
  updatedAt: new Date("2026-08-28T00:00:00.000Z"),
};

const organizationMemberFixture: OrganizationMember = {
  id: "member-1",
  organizationId: "paca-default",
  userId: "user-1",
  userName: "Organization Owner",
  userEmail: "owner@example.com",
  userImage: null,
  roles: [organizationRoleFixture],
  createdAt: new Date("2026-08-28T00:00:00.000Z"),
};

const projectRoleFixture: ProjectRole = {
  id: "b056c1a8-2070-43fe-992d-92747fac7a27",
  projectId: projectFixture.id,
  name: "Editor",
  description: "Project editor",
  isBuiltIn: true,
  grants: [{ resource: "tasks", action: "write" }],
  createdAt: new Date("2026-08-28T00:00:00.000Z"),
  updatedAt: new Date("2026-08-28T00:00:00.000Z"),
};

const projectMemberFixture: ProjectMember = {
  id: "61da0adb-9d43-4076-8191-3b64ed5d8ebf",
  projectId: projectFixture.id,
  userId: "user-2",
  userName: "Project Member",
  userEmail: "member@example.com",
  userImage: null,
  role: projectRoleFixture,
  createdAt: new Date("2026-08-28T00:00:00.000Z"),
};

function fakeSystemRoles(overrides: Partial<SystemRoleRuntime> = {}): SystemRoleRuntime {
  return {
    list: async () => [],
    create: async () => systemRoleFixture,
    update: async () => systemRoleFixture,
    delete: async () => undefined,
    replaceUserRoles: async () => [systemRoleFixture],
    ...overrides,
  };
}

function fakeProjects(overrides: Partial<ProjectRuntime> = {}): ProjectRuntime {
  return {
    list: async () => ({ items: [], total: 0, page: 1, pageSize: 50 }),
    stats: async () => ({ openTaskCount: 0, teamMemberCount: 0, aiAgentCount: 0 }),
    get: async () => projectFixture,
    create: async () => projectFixture,
    update: async () => projectFixture,
    archive: async () => undefined,
    ...overrides,
  };
}

function fakeOrganizationAccess(
  overrides: Partial<OrganizationAccessRuntime> = {},
): OrganizationAccessRuntime {
  return {
    listRoles: async () => [organizationRoleFixture],
    createRole: async () => organizationRoleFixture,
    updateRole: async () => organizationRoleFixture,
    deleteRole: async () => undefined,
    listMembers: async () => [organizationMemberFixture],
    replaceMemberRoles: async () => organizationMemberFixture,
    ...overrides,
  };
}

function fakeProjectAccess(overrides: Partial<ProjectAccessRuntime> = {}): ProjectAccessRuntime {
  return {
    listRoles: async () => [projectRoleFixture],
    createRole: async () => projectRoleFixture,
    updateRole: async () => projectRoleFixture,
    deleteRole: async () => undefined,
    listMembers: async () => [projectMemberFixture],
    addMember: async () => projectMemberFixture,
    replaceMemberRole: async () => projectMemberFixture,
    removeMember: async () => undefined,
    listUsers: async () => ({ items: [], total: 0, page: 1, pageSize: 20 }),
    ...overrides,
  };
}

describe("worker api", () => {
  it("returns a public liveness response with a request id", async () => {
    const app = createApp({ log: vi.fn() });
    const response = await app.request("/health", {}, testBindings());
    const body = await response.json<{
      status: string;
      service: string;
      environment: string;
      requestId: string;
    }>();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe(body.requestId);
    expect(body).toMatchObject({
      status: "ok",
      service: "paca-worker-api",
      environment: "test",
    });
  });

  it("forwards Better Auth routes through the injected handler", async () => {
    const authHandler = vi.fn(async () => Response.json({ session: null }));
    const app = createApp({ authHandler, log: vi.fn() });
    const response = await app.request("/api/auth/get-session", {}, testBindings());

    expect(response.status).toBe(200);
    expect(authHandler).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toEqual({ session: null });
  });

  it("rejects an untrusted browser origin before Better Auth", async () => {
    const authHandler = vi.fn(async () => Response.json({ session: null }));
    const app = createApp({ authHandler, log: vi.fn() });
    const response = await app.request(
      "/api/auth/get-session",
      { headers: { origin: "https://attacker.example" } },
      testBindings({
        BETTER_AUTH_URL: "https://api.paca.internal",
        TRUSTED_ORIGINS: "https://paca.internal",
      }),
    );

    expect(response.status).toBe(403);
    expect(authHandler).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ code: "UNTRUSTED_ORIGIN" });
  });

  it("answers trusted auth preflight requests without opening the database", async () => {
    const authHandler = vi.fn(async () => Response.json({ session: null }));
    const app = createApp({ authHandler, log: vi.fn() });
    const response = await app.request(
      "/api/auth/sign-in/email",
      {
        method: "OPTIONS",
        headers: { origin: "https://paca.internal" },
      },
      testBindings({ TRUSTED_ORIGINS: "https://paca.internal" }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://paca.internal");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(authHandler).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated business API request", async () => {
    const currentUserSession = vi.fn(async () => null);
    const app = createApp({ currentUserSession, log: vi.fn() });
    const response = await app.request("/api/me", {}, testBindings());

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(currentUserSession).toHaveBeenCalledOnce();
  });

  it("returns only the current authenticated user session projection", async () => {
    const currentUserSession = vi.fn(async () => ({
      id: "session-1",
      user: {
        id: "user-1",
        name: "Internal Tester",
        email: "internal-tester@paca.test",
        emailVerified: false,
        image: null,
        createdAt: "2026-08-27T00:00:00.000Z",
      },
      expiresAt: "2026-09-03T00:00:00.000Z",
    }));
    const app = createApp({ currentUserSession, log: vi.fn() });
    const response = await app.request("/api/me", {}, testBindings());
    const body = await response.json<{
      data: { user: { email: string }; expiresAt: string };
    }>();

    expect(response.status).toBe(200);
    expect(body.data.user.email).toBe("internal-tester@paca.test");
    expect(body.data.expiresAt).toBe("2026-09-03T00:00:00.000Z");
    expect(JSON.stringify(body)).not.toContain("session_token");
  });

  it("protects the project collection through the organization boundary", async () => {
    const authorizeOrganizationPermission = vi.fn(async () => ({
      authenticated: false as const,
    }));
    const app = createApp({ authorizeOrganizationPermission, log: vi.fn() });
    const response = await app.request("/api/v1/projects", {}, testBindings());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error_code: "AUTH_UNAUTHENTICATED",
    });
  });

  it("returns 404 before organization access runtime for an unknown organization", async () => {
    const authorizeOrganizationPermission = vi.fn(async () => ({
      authenticated: true as const,
      userId: "user-1",
      decision: { scopeExists: false, allowed: false, grants: [] },
    }));
    const listRoles = vi.fn();
    const app = createApp({
      authorizeOrganizationPermission,
      organizationAccess: fakeOrganizationAccess({ listRoles }),
      log: vi.fn(),
    });
    const response = await app.request("/api/v1/organizations/missing/roles", {}, testBindings());

    expect(response.status).toBe(404);
    expect(listRoles).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error_code: "ORGANIZATION_NOT_FOUND",
    });
  });

  it("returns organization roles through the organizationRoles boundary", async () => {
    const authorizeOrganizationPermission = vi.fn(async () => ({
      authenticated: true as const,
      userId: "user-1",
      decision: {
        scopeExists: true,
        allowed: true,
        grants: [{ resource: "organizationRoles" as const, action: "read" }],
      },
    }));
    const listRoles = vi.fn(async () => [organizationRoleFixture]);
    const app = createApp({
      authorizeOrganizationPermission,
      organizationAccess: fakeOrganizationAccess({ listRoles }),
      log: vi.fn(),
    });
    const response = await app.request(
      "/api/v1/organizations/paca-default/roles",
      {},
      testBindings(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: [
        {
          id: organizationRoleFixture.id,
          organization_id: "paca-default",
          role_name: "OWNER",
          permissions: { "organization.roles.write": true },
          is_built_in: true,
        },
      ],
    });
    expect(authorizeOrganizationPermission).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      "paca-default",
      { organizationRoles: ["read"] },
    );
  });

  it("passes actor grants into organization multi-role replacement", async () => {
    const grants = [
      { resource: "organizationMembers", action: "write" },
      { resource: "organizationRoles", action: "write" },
    ] satisfies PermissionGrant[];
    const authorizeOrganizationPermission = vi.fn(async () => ({
      authenticated: true as const,
      userId: "user-1",
      decision: { scopeExists: true, allowed: true, grants },
    }));
    const replaceMemberRoles = vi.fn(async () => organizationMemberFixture);
    const app = createApp({
      authorizeOrganizationPermission,
      organizationAccess: fakeOrganizationAccess({ replaceMemberRoles }),
      log: vi.fn(),
    });
    const response = await app.request(
      "/api/v1/organizations/paca-default/members/member-1/roles",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role_ids: [organizationRoleFixture.id] }),
      },
      testBindings(),
    );

    expect(response.status).toBe(200);
    expect(replaceMemberRoles).toHaveBeenCalledWith(
      expect.anything(),
      grants,
      "paca-default",
      "member-1",
      [organizationRoleFixture.id],
    );
  });

  it("returns the project collection from the domain runtime", async () => {
    const authorizeOrganizationPermission = vi.fn(async () => ({
      authenticated: true as const,
      userId: "user-1",
      decision: {
        scopeExists: true,
        allowed: true,
        grants: [{ resource: "projects" as const, action: "read" }],
      },
    }));
    const list = vi.fn(async () => ({ items: [projectFixture], total: 1, page: 1, pageSize: 50 }));
    const app = createApp({
      authorizeOrganizationPermission,
      projects: fakeProjects({ list }),
      log: vi.fn(),
    });
    const response = await app.request("/api/v1/projects", {}, testBindings());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        items: [{ id: projectFixture.id, task_id_prefix: "CF" }],
        total: 1,
        page: 1,
        page_size: 50,
      },
    });
    expect(list).toHaveBeenCalledWith(expect.anything(), "paca-default", 1, 50);
  });

  it("creates a project with the authenticated organization actor", async () => {
    const authorizeOrganizationPermission = vi.fn(async () => ({
      authenticated: true as const,
      userId: "user-1",
      decision: {
        scopeExists: true,
        allowed: true,
        grants: [{ resource: "projects" as const, action: "create" }],
      },
    }));
    const create = vi.fn(async () => projectFixture);
    const app = createApp({
      authorizeOrganizationPermission,
      projects: fakeProjects({ create }),
      log: vi.fn(),
    });
    const response = await app.request(
      "/api/v1/projects",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Cloudflare migration",
          description: "Internal preview project",
          task_id_prefix: "CF",
        }),
      },
      testBindings(),
    );

    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith(expect.anything(), "paca-default", "user-1", {
      name: "Cloudflare migration",
      description: "Internal preview project",
      taskIdPrefix: "CF",
      isPublic: undefined,
      settings: undefined,
    });
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { id: projectFixture.id, name: "Cloudflare migration" },
    });
  });

  it("reads a project only after project-scoped authorization", async () => {
    const authorizeProjectPermission = vi.fn(async () => ({
      authenticated: true as const,
      userId: "user-1",
      decision: {
        scopeExists: true,
        allowed: true,
        grants: [{ resource: "projects" as const, action: "read" }],
      },
    }));
    const get = vi.fn(async () => projectFixture);
    const app = createApp({
      authorizeProjectPermission,
      projects: fakeProjects({ get }),
      log: vi.fn(),
    });
    const response = await app.request(`/api/v1/projects/${projectFixture.id}`, {}, testBindings());

    expect(response.status).toBe(200);
    expect(authorizeProjectPermission).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      projectFixture.id,
      { projects: ["read"] },
    );
    expect(get).toHaveBeenCalledWith(expect.anything(), projectFixture.id);
  });

  it("rejects malformed project ids before authorization or runtime access", async () => {
    const authorizeProjectPermission = vi.fn();
    const get = vi.fn();
    const app = createApp({
      authorizeProjectPermission,
      projects: fakeProjects({ get }),
      log: vi.fn(),
    });
    const response = await app.request("/api/v1/projects/not-a-uuid", {}, testBindings());

    expect(response.status).toBe(400);
    expect(authorizeProjectPermission).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("returns project roles through the projectRoles permission boundary", async () => {
    const authorizeProjectPermission = vi.fn(async () => ({
      authenticated: true as const,
      userId: "user-1",
      decision: {
        scopeExists: true,
        allowed: true,
        grants: [{ resource: "projectRoles" as const, action: "read" }],
      },
    }));
    const listRoles = vi.fn(async () => [projectRoleFixture]);
    const app = createApp({
      authorizeProjectPermission,
      projectAccess: fakeProjectAccess({ listRoles }),
      log: vi.fn(),
    });
    const response = await app.request(
      `/api/v1/projects/${projectFixture.id}/roles`,
      {},
      testBindings(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: [
        {
          id: projectRoleFixture.id,
          project_id: projectFixture.id,
          role_name: "Editor",
          permissions: { "tasks.write": true },
          is_built_in: true,
        },
      ],
    });
    expect(listRoles).toHaveBeenCalledWith(expect.anything(), projectFixture.id);
  });

  it("passes the actor grant ceiling context when creating a project role", async () => {
    const grants = [
      { resource: "projectRoles", action: "write" },
      { resource: "tasks", action: "write" },
    ] satisfies PermissionGrant[];
    const authorizeProjectPermission = vi.fn(async () => ({
      authenticated: true as const,
      userId: "user-1",
      decision: { scopeExists: true, allowed: true, grants },
    }));
    const createRole = vi.fn(async () => projectRoleFixture);
    const app = createApp({
      authorizeProjectPermission,
      projectAccess: fakeProjectAccess({ createRole }),
      log: vi.fn(),
    });
    const response = await app.request(
      `/api/v1/projects/${projectFixture.id}/roles`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role_name: "Editor", permissions: { "tasks.write": true } }),
      },
      testBindings(),
    );

    expect(response.status).toBe(201);
    expect(createRole).toHaveBeenCalledWith(expect.anything(), grants, projectFixture.id, {
      name: "Editor",
      description: undefined,
      permissions: { "tasks.write": true },
    });
  });

  it("returns the legacy human-member projection and rejects agent-shaped additions", async () => {
    const grants = [{ resource: "projectMembers", action: "write" }] satisfies PermissionGrant[];
    const authorizeProjectPermission = vi.fn(async () => ({
      authenticated: true as const,
      userId: "user-1",
      decision: { scopeExists: true, allowed: true, grants },
    }));
    const addMember = vi.fn(async () => projectMemberFixture);
    const app = createApp({
      authorizeProjectPermission,
      projectAccess: fakeProjectAccess({ addMember }),
      log: vi.fn(),
    });

    const listResponse = await app.request(
      `/api/v1/projects/${projectFixture.id}/members`,
      {},
      testBindings(),
    );
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      data: [
        {
          id: projectMemberFixture.id,
          user_id: "user-2",
          username: "member",
          full_name: "Project Member",
          project_role_id: projectRoleFixture.id,
          member_type: "human",
        },
      ],
    });

    const addAgentResponse = await app.request(
      `/api/v1/projects/${projectFixture.id}/members`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent_id: "agent-1",
          project_role_id: projectRoleFixture.id,
        }),
      },
      testBindings(),
    );
    expect(addAgentResponse.status).toBe(400);
    expect(addMember).not.toHaveBeenCalled();
  });

  it("returns system permissions from the Paca Permission authority", async () => {
    const loadSystemPermissions = vi.fn(async () => ({
      authenticated: true as const,
      userId: "user-1",
      grants: [
        { resource: "users" as const, action: "read" },
        { resource: "globalRoles" as const, action: "assign" },
      ],
    }));
    const app = createApp({ loadSystemPermissions, log: vi.fn() });
    const response = await app.request("/api/v1/users/me/global-permissions", {}, testBindings());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { permissions: ["users.read", "global_roles.assign"] },
    });
    expect(loadSystemPermissions).toHaveBeenCalledOnce();
  });

  it("rejects a direct project permission request without a session", async () => {
    const authorizeProjectPermission = vi.fn(async () => ({ authenticated: false as const }));
    const app = createApp({ authorizeProjectPermission, log: vi.fn() });
    const response = await app.request(
      "/api/v1/projects/4fb5db43-8288-4e11-afca-65bdad55a49d/members/me/permissions",
      {},
      testBindings(),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error_code: "AUTH_UNAUTHENTICATED",
    });
  });

  it("rejects an authenticated project request when its permission is missing", async () => {
    const authorizeProjectPermission = vi.fn(async () => ({
      authenticated: true as const,
      userId: "user-1",
      decision: { allowed: false, grants: [], scopeExists: true },
    }));
    const app = createApp({ authorizeProjectPermission, log: vi.fn() });
    const response = await app.request(
      "/api/v1/projects/4fb5db43-8288-4e11-afca-65bdad55a49d/members/me/permissions",
      {},
      testBindings(),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error_code: "PERMISSION_DENIED",
    });
  });

  it("returns project permissions only after the Hono middleware allows the request", async () => {
    const authorizeProjectPermission = vi.fn(async () => ({
      authenticated: true as const,
      userId: "user-1",
      decision: {
        allowed: true,
        grants: [
          { resource: "projects" as const, action: "read" },
          { resource: "tasks" as const, action: "write" },
        ],
        scopeExists: true,
      },
    }));
    const app = createApp({ authorizeProjectPermission, log: vi.fn() });
    const response = await app.request(
      "/api/v1/projects/4fb5db43-8288-4e11-afca-65bdad55a49d/members/me/permissions",
      {},
      testBindings(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { permissions: { "projects.read": true, "tasks.write": true } },
    });
    expect(authorizeProjectPermission).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      "4fb5db43-8288-4e11-afca-65bdad55a49d",
      { projects: ["read"] },
    );
  });

  it("protects global role administration with a system permission", async () => {
    const authorizeSystemPermission = vi.fn(async () => ({ authenticated: false as const }));
    const systemRoles = fakeSystemRoles({ list: vi.fn() });
    const app = createApp({ authorizeSystemPermission, systemRoles, log: vi.fn() });
    const response = await app.request("/api/v1/admin/global-roles", {}, testBindings());

    expect(response.status).toBe(401);
    expect(systemRoles.list).not.toHaveBeenCalled();
    expect(authorizeSystemPermission).toHaveBeenCalledWith(expect.any(Request), expect.anything(), {
      globalRoles: ["read"],
    });
  });

  it("returns the legacy React contract for authorized system roles", async () => {
    const grants = [{ resource: "globalRoles", action: "read" }] satisfies PermissionGrant[];
    const authorizeSystemPermission = vi.fn(async () => ({
      authenticated: true as const,
      userId: "user-1",
      allowed: true,
      grants,
    }));
    const systemRoles = fakeSystemRoles({ list: vi.fn(async () => [systemRoleFixture]) });
    const app = createApp({ authorizeSystemPermission, systemRoles, log: vi.fn() });
    const response = await app.request("/api/v1/admin/global-roles", {}, testBindings());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: [
        {
          id: systemRoleFixture.id,
          name: "Maintainer",
          description: "Maintains users",
          permissions: { "users.read": true },
          is_built_in: false,
          created_at: "2026-08-28T00:00:00.000Z",
          updated_at: "2026-08-28T00:00:00.000Z",
        },
      ],
    });
  });

  it("passes the authenticated actor's grants into system role creation", async () => {
    const actorGrants = [
      { resource: "globalRoles", action: "write" },
      { resource: "users", action: "read" },
    ] satisfies PermissionGrant[];
    const authorizeSystemPermission = vi.fn(async () => ({
      authenticated: true as const,
      userId: "user-1",
      allowed: true,
      grants: actorGrants,
    }));
    const create = vi.fn(async () => systemRoleFixture);
    const app = createApp({
      authorizeSystemPermission,
      systemRoles: fakeSystemRoles({ create }),
      log: vi.fn(),
    });
    const response = await app.request(
      "/api/v1/admin/global-roles",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Maintainer",
          description: "Maintains users",
          permissions: { "users.read": true },
        }),
      },
      testBindings(),
    );

    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith(expect.anything(), actorGrants, {
      name: "Maintainer",
      description: "Maintains users",
      permissions: { "users.read": true },
    });
  });

  it("maps grant escalation and built-in protection to stable API errors", async () => {
    const authorizeSystemPermission = vi.fn(async () => ({
      authenticated: true as const,
      userId: "user-1",
      allowed: true,
      grants: [{ resource: "globalRoles" as const, action: "write" }],
    }));
    const app = createApp({
      authorizeSystemPermission,
      systemRoles: fakeSystemRoles({
        create: async () => {
          throw new SystemRoleError(systemRoleErrorCodes.permissionEscalation);
        },
        delete: async () => {
          throw new SystemRoleError(systemRoleErrorCodes.builtIn);
        },
      }),
      log: vi.fn(),
    });

    const createResponse = await app.request(
      "/api/v1/admin/global-roles",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Escalated", permissions: { "users.write": true } }),
      },
      testBindings(),
    );
    expect(createResponse.status).toBe(403);
    await expect(createResponse.json()).resolves.toMatchObject({
      error_code: systemRoleErrorCodes.permissionEscalation,
    });

    const deleteResponse = await app.request(
      `/api/v1/admin/global-roles/${systemRoleFixture.id}`,
      { method: "DELETE" },
      testBindings(),
    );
    expect(deleteResponse.status).toBe(409);
    await expect(deleteResponse.json()).resolves.toMatchObject({
      error_code: systemRoleErrorCodes.builtIn,
    });
  });

  it("rejects malformed role ids before invoking the repository", async () => {
    const authorizeSystemPermission = vi.fn(async () => ({
      authenticated: true as const,
      userId: "user-1",
      allowed: true,
      grants: [{ resource: "globalRoles" as const, action: "write" }],
    }));
    const systemRoles = fakeSystemRoles({ update: vi.fn() });
    const app = createApp({ authorizeSystemPermission, systemRoles, log: vi.fn() });
    const response = await app.request(
      "/api/v1/admin/global-roles/not-a-uuid",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Maintainer", permissions: {} }),
      },
      testBindings(),
    );

    expect(response.status).toBe(400);
    expect(systemRoles.update).not.toHaveBeenCalled();
  });

  it("replaces a user's system roles through the assign permission boundary", async () => {
    const actorGrants = [
      { resource: "globalRoles", action: "assign" },
      { resource: "users", action: "read" },
    ] satisfies PermissionGrant[];
    const authorizeSystemPermission = vi.fn(async () => ({
      authenticated: true as const,
      userId: "actor-1",
      allowed: true,
      grants: actorGrants,
    }));
    const replaceUserRoles = vi.fn(async () => [systemRoleFixture]);
    const app = createApp({
      authorizeSystemPermission,
      systemRoles: fakeSystemRoles({ replaceUserRoles }),
      log: vi.fn(),
    });
    const response = await app.request(
      "/api/v1/admin/users/user-2/global-roles",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role_ids: [systemRoleFixture.id] }),
      },
      testBindings(),
    );

    expect(response.status).toBe(200);
    expect(authorizeSystemPermission).toHaveBeenCalledWith(expect.any(Request), expect.anything(), {
      globalRoles: ["assign"],
    });
    expect(replaceUserRoles).toHaveBeenCalledWith(expect.anything(), actorGrants, "user-2", [
      systemRoleFixture.id,
    ]);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        user_id: "user-2",
        roles: [{ id: systemRoleFixture.id, permissions: { "users.read": true } }],
      },
    });
  });

  it("rejects malformed system role assignment bodies before runtime access", async () => {
    const authorizeSystemPermission = vi.fn(async () => ({
      authenticated: true as const,
      userId: "actor-1",
      allowed: true,
      grants: [{ resource: "globalRoles" as const, action: "assign" }],
    }));
    const systemRoles = fakeSystemRoles({ replaceUserRoles: vi.fn() });
    const app = createApp({ authorizeSystemPermission, systemRoles, log: vi.fn() });
    const response = await app.request(
      "/api/v1/admin/users/user-2/global-roles",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role_ids: [] }),
      },
      testBindings(),
    );

    expect(response.status).toBe(400);
    expect(systemRoles.replaceUserRoles).not.toHaveBeenCalled();
  });

  it("returns a stable conflict when assignment would remove the last super administrator", async () => {
    const authorizeSystemPermission = vi.fn(async () => ({
      authenticated: true as const,
      userId: "actor-1",
      allowed: true,
      grants: [{ resource: "*" as const, action: "*" }],
    }));
    const app = createApp({
      authorizeSystemPermission,
      systemRoles: fakeSystemRoles({
        replaceUserRoles: async () => {
          throw new SystemRoleError(systemRoleErrorCodes.lastSuperAdmin);
        },
      }),
      log: vi.fn(),
    });
    const response = await app.request(
      "/api/v1/admin/users/user-2/global-roles",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role_ids: [systemRoleFixture.id] }),
      },
      testBindings(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error_code: systemRoleErrorCodes.lastSuperAdmin,
    });
  });

  it("does not call the database without the internal token", async () => {
    const databaseHealth = vi.fn(async () => ({ latencyMs: 1 }));
    const app = createApp({ databaseHealth, log: vi.fn() });
    const response = await app.request(
      "/internal/health/database",
      {},
      testBindings({ INTERNAL_HEALTH_TOKEN: "configured-token" }),
    );

    expect(response.status).toBe(401);
    expect(databaseHealth).not.toHaveBeenCalled();
  });

  it("reports a missing internal token as unavailable", async () => {
    const app = createApp({ log: vi.fn() });
    const response = await app.request(
      "/internal/health/database",
      { headers: { authorization: "Bearer supplied-token" } },
      testBindings(),
    );

    expect(response.status).toBe(503);
  });

  it("checks the database only after successful authorization", async () => {
    const databaseHealth = vi.fn(async () => ({ latencyMs: 7 }));
    const app = createApp({ databaseHealth, log: vi.fn() });
    const response = await app.request(
      "/internal/health/database",
      { headers: { authorization: "Bearer configured-token" } },
      testBindings({ INTERNAL_HEALTH_TOKEN: "configured-token" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      dependency: "postgresql",
      connection: "hyperdrive",
      latencyMs: 7,
    });
    expect(databaseHealth).toHaveBeenCalledOnce();
  });

  it("returns a sanitized error when the database check fails", async () => {
    const app = createApp({
      databaseHealth: async () => {
        throw new Error("postgres://secret-user:secret-password@secret-host/database");
      },
      log: vi.fn(),
    });
    const response = await app.request(
      "/internal/health/database",
      { headers: { authorization: "Bearer configured-token" } },
      testBindings({ INTERNAL_HEALTH_TOKEN: "configured-token" }),
    );
    const responseText = await response.text();

    expect(response.status).toBe(500);
    expect(responseText).not.toContain("secret-user");
    expect(responseText).not.toContain("secret-password");
    expect(responseText).not.toContain("secret-host");
  });

  it("returns a consistent not-found envelope", async () => {
    const app = createApp({ log: vi.fn() });
    const response = await app.request("/missing", {}, testBindings());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "NOT_FOUND" });
  });

  it("distinguishes a retained Go domain from an unknown API route", async () => {
    const app = createApp({ log: vi.fn() });
    const response = await app.request(
      "/api/v1/projects/project-1/environments/environment-1",
      {},
      testBindings(),
    );

    expect(response.status).toBe(501);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-paca-api-migration-domain")).toBe("environments");
    await expect(response.json()).resolves.toMatchObject({
      status: "unavailable",
      code: "API_DOMAIN_NOT_MIGRATED",
      domain: "environments",
      authority: "go-api",
      retryable: false,
    });
  });
});
