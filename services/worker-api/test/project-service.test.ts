import { describe, expect, it, vi } from "vitest";

import {
  type PersistedProjectCreate,
  type PersistedProjectUpdate,
  type Project,
  type ProjectError,
  type ProjectRepository,
  ProjectService,
  projectErrorCodes,
} from "../src/project/service";

const project: Project = {
  id: "6bdb7f3a-e59d-4826-8383-0104192157a8",
  organizationId: "paca-default",
  name: "Cloudflare migration",
  description: "",
  taskIdPrefix: "CF",
  isPublic: false,
  settings: {},
  createdBy: "user-1",
  createdAt: new Date("2026-08-28T00:00:00.000Z"),
  updatedAt: new Date("2026-08-28T00:00:00.000Z"),
};

function repository(overrides: Partial<ProjectRepository> = {}): ProjectRepository {
  return {
    list: async (_organizationId, page, pageSize) => ({ items: [], total: 0, page, pageSize }),
    stats: async () => ({ openTaskCount: 0, teamMemberCount: 0, aiAgentCount: 0 }),
    findById: async () => project,
    create: async () => project,
    update: async () => project,
    archive: async () => undefined,
    ...overrides,
  };
}

describe("project service", () => {
  it("normalizes a project and seeds the creator roles", async () => {
    const create = vi.fn(async (_input: PersistedProjectCreate) => project);
    const service = new ProjectService(repository({ create }));

    await service.create("paca-default", "user-1", {
      name: "  Cloudflare migration  ",
      description: "  Internal preview  ",
      isPublic: true,
      settings: { color: "orange" },
    });

    const input = create.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      organizationId: "paca-default",
      createdBy: "user-1",
      name: "Cloudflare migration",
      description: "Internal preview",
      taskIdPrefix: "CM",
      isPublic: true,
      settings: { color: "orange" },
    });
    expect(input?.defaultRoles.map((role) => role.name)).toEqual(["Admin", "Editor", "Viewer"]);
    expect(input?.defaultRoles[0]?.grants).toContainEqual({ resource: "projects", action: "*" });
  });

  it("uses a stable fallback prefix for names without ASCII letters", async () => {
    const create = vi.fn(async (_input: PersistedProjectCreate) => project);
    const service = new ProjectService(repository({ create }));

    await service.create("paca-default", "user-1", { name: "云端项目" });

    expect(create.mock.calls[0]?.[0].taskIdPrefix).toBe("PROJ");
  });

  it("rejects malformed names, prefixes and settings", async () => {
    const service = new ProjectService(repository());

    await expect(service.create("paca-default", "user-1", { name: " " })).rejects.toMatchObject({
      code: projectErrorCodes.nameInvalid,
    } satisfies Partial<ProjectError>);
    await expect(
      service.create("paca-default", "user-1", { name: "Paca", taskIdPrefix: "TOO-LONG-PREFIX" }),
    ).rejects.toMatchObject({
      code: projectErrorCodes.prefixInvalid,
    } satisfies Partial<ProjectError>);
    await expect(
      service.create("paca-default", "user-1", { name: "Paca", settings: [] }),
    ).rejects.toMatchObject({
      code: projectErrorCodes.settingsInvalid,
    } satisfies Partial<ProjectError>);
  });

  it("normalizes updates and avoids a write for an empty patch", async () => {
    const update = vi.fn(async (_projectId: string, _input: PersistedProjectUpdate) => project);
    const findById = vi.fn(async () => project);
    const service = new ProjectService(repository({ update, findById }));

    await service.update(project.id, { description: "  Updated  ", taskIdPrefix: "cf2" });
    expect(update).toHaveBeenCalledWith(project.id, {
      description: "Updated",
      taskIdPrefix: "CF2",
    });

    await service.update(project.id, {});
    expect(findById).toHaveBeenCalledWith(project.id);
  });

  it("clamps list pagination to the repository contract", async () => {
    const list = vi.fn(async (_organizationId: string, page: number, pageSize: number) => ({
      items: [],
      total: 0,
      page,
      pageSize,
    }));
    const service = new ProjectService(repository({ list }));

    await service.list("paca-default", -2, 500);
    expect(list).toHaveBeenCalledWith("paca-default", 1, 100);
  });
});
