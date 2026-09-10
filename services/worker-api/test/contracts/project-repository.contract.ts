import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  PersistedProjectCreate,
  ProjectRepository,
  ProjectRoleSeed,
} from "../../src/project/service";
import { ProjectError, projectErrorCodes } from "../../src/project/service";

export type ProjectRepositoryContractFixture = {
  repository: ProjectRepository;
  organizationId: string;
  actorId: string;
  cleanup(): Promise<void>;
};

type FixtureFactory = () => Promise<ProjectRepositoryContractFixture>;

function role(name: string): ProjectRoleSeed {
  return {
    id: crypto.randomUUID(),
    name,
    description: `${name} contract role`,
    grants: [{ resource: "projects", action: "read" }],
  };
}

function projectInput(
  fixture: ProjectRepositoryContractFixture,
  name: string,
): PersistedProjectCreate {
  const id = crypto.randomUUID();
  return {
    id,
    organizationId: fixture.organizationId,
    name,
    slug: `contract-${id}`,
    description: "Repository contract fixture",
    taskIdPrefix: "CT",
    isPublic: false,
    settings: { contract: true },
    createdBy: fixture.actorId,
    defaultRoles: [
      {
        ...role("Admin"),
        grants: [{ resource: "projects", action: "*" }],
      },
      role("Viewer"),
    ],
    defaultTaskTypes: [
      {
        id: crypto.randomUUID(),
        name: "Task",
        icon: "circle-check",
        color: "#3b82f6",
        description: "Contract task",
        isDefault: true,
        isSystem: true,
      },
    ],
    defaultTaskStatuses: [
      {
        id: crypto.randomUUID(),
        name: "Backlog",
        color: "#64748b",
        position: 0,
        category: "backlog",
        isDefault: true,
      },
    ],
  };
}

export function projectRepositoryContract(name: string, createFixture: FixtureFactory): void {
  describe(name, () => {
    let fixture: ProjectRepositoryContractFixture;

    beforeEach(async () => {
      fixture = await createFixture();
    });

    afterEach(async () => {
      await fixture.cleanup();
    });

    it("persists, reads, lists, updates, and archives a Project aggregate", async () => {
      const input = projectInput(fixture, "Contract Project");
      const created = await fixture.repository.create(input);

      expect(created).toMatchObject({
        id: input.id,
        organizationId: fixture.organizationId,
        name: "Contract Project",
        taskIdPrefix: "CT",
        settings: { contract: true },
      });
      await expect(fixture.repository.findById(input.id)).resolves.toMatchObject({ id: input.id });
      await expect(fixture.repository.list(fixture.organizationId, 1, 10)).resolves.toMatchObject({
        total: 1,
        items: [expect.objectContaining({ id: input.id })],
      });
      await expect(fixture.repository.stats(fixture.organizationId)).resolves.toEqual({
        openTaskCount: 0,
        teamMemberCount: 1,
        aiAgentCount: 0,
      });

      await expect(
        fixture.repository.update(input.id, {
          name: "Updated Contract Project",
          isPublic: true,
          settings: { version: 2 },
        }),
      ).resolves.toMatchObject({
        name: "Updated Contract Project",
        isPublic: true,
        settings: { version: 2 },
      });

      await fixture.repository.archive(input.id);
      await expect(fixture.repository.findById(input.id)).rejects.toMatchObject({
        code: projectErrorCodes.notFound,
      });
      await expect(fixture.repository.list(fixture.organizationId, 1, 10)).resolves.toMatchObject({
        total: 0,
        items: [],
      });
    });

    it("enforces case-insensitive Project names inside one Organization", async () => {
      await fixture.repository.create(projectInput(fixture, "Unique Name"));

      await expect(fixture.repository.create(projectInput(fixture, "unique name"))).rejects.toEqual(
        new ProjectError(projectErrorCodes.nameTaken),
      );
    });

    it("rolls back the complete aggregate when a child row violates a constraint", async () => {
      const input = projectInput(fixture, "Atomic Project");
      const duplicatedRoleId = crypto.randomUUID();
      input.defaultRoles = [
        { ...role("Admin"), id: duplicatedRoleId },
        { ...role("Viewer"), id: duplicatedRoleId },
      ];

      await expect(fixture.repository.create(input)).rejects.toBeDefined();
      await expect(fixture.repository.list(fixture.organizationId, 1, 10)).resolves.toMatchObject({
        total: 0,
        items: [],
      });
      await expect(fixture.repository.findById(input.id)).rejects.toMatchObject({
        code: projectErrorCodes.notFound,
      });
    });
  });
}
