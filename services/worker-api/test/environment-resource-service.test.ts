import { describe, expect, it, vi } from "vitest";
import { PostgresEnvironmentScopeRepository } from "../src/environment/postgres-repository";
import {
  type EnvironmentResource,
  type EnvironmentResourceRepository,
  EnvironmentResourceService,
  environmentResourceErrorCodes,
  type PersistedEnvironmentCreate,
} from "../src/environment/service";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT_ID = "22222222-2222-4222-8222-222222222222";

const environment: EnvironmentResource = {
  id: ENVIRONMENT_ID,
  projectId: PROJECT_ID,
  name: "Primary sandbox",
  backend: "cloudflare-sandbox",
  createdBy: "user-1",
  createdAt: new Date("2026-09-09T00:00:00.000Z"),
  updatedAt: new Date("2026-09-09T00:00:00.000Z"),
};

function repository(
  overrides: Partial<EnvironmentResourceRepository> = {},
): EnvironmentResourceRepository {
  return {
    find: async () => null,
    list: async () => [environment],
    findResource: async () => environment,
    create: async () => environment,
    update: async () => environment,
    archive: async () => undefined,
    ...overrides,
  };
}

describe("environment resource service", () => {
  it("creates a Cloudflare Sandbox scope with a server-owned provider reference", async () => {
    const create = vi.fn(async (_input: PersistedEnvironmentCreate) => environment);
    const service = new EnvironmentResourceService(repository({ create }));

    await service.create(PROJECT_ID, "user-1", { name: "  Primary sandbox  " });

    const input = create.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      projectId: PROJECT_ID,
      name: "Primary sandbox",
      backend: "cloudflare-sandbox",
      createdBy: "user-1",
    });
    expect(input?.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(input?.gatewayReference).toBe(`paca-env-${input?.id}`);
    expect(input?.createdAt).toBeInstanceOf(Date);
    expect(input?.updatedAt).toBe(input?.createdAt);
  });

  it("rejects blank and oversized names before persistence", async () => {
    const create = vi.fn(repository().create);
    const service = new EnvironmentResourceService(repository({ create }));

    await expect(service.create(PROJECT_ID, "user-1", { name: "   " })).rejects.toMatchObject({
      code: environmentResourceErrorCodes.nameInvalid,
    });
    await expect(
      service.create(PROJECT_ID, "user-1", { name: "x".repeat(101) }),
    ).rejects.toMatchObject({ code: environmentResourceErrorCodes.nameInvalid });
    expect(create).not.toHaveBeenCalled();
  });

  it("normalizes rename and avoids an empty repository write", async () => {
    const update = vi.fn(repository().update);
    const findResource = vi.fn(repository().findResource);
    const service = new EnvironmentResourceService(repository({ update, findResource }));

    await service.update(PROJECT_ID, ENVIRONMENT_ID, { name: "  Renamed  " });
    expect(update).toHaveBeenCalledWith(PROJECT_ID, ENVIRONMENT_ID, { name: "Renamed" });

    await service.update(PROJECT_ID, ENVIRONMENT_ID, {});
    expect(findResource).toHaveBeenCalledWith(PROJECT_ID, ENVIRONMENT_ID);
    expect(update).toHaveBeenCalledOnce();
  });
});

describe("postgres environment resource errors", () => {
  it("maps a Drizzle-wrapped environment name constraint violation", async () => {
    const database = {
      transaction: async () => {
        throw Object.assign(new Error("query failed"), {
          cause: Object.assign(new Error("duplicate"), {
            code: "23505",
            constraint: "paca_environment_scope_project_name_uidx",
          }),
        });
      },
    };
    const repository = new PostgresEnvironmentScopeRepository(database as never);

    await expect(
      repository.create({
        ...environment,
        gatewayReference: `paca-env-${ENVIRONMENT_ID}`,
      }),
    ).rejects.toMatchObject({ code: environmentResourceErrorCodes.nameTaken });
  });

  it("does not disguise a different unique constraint as a name conflict", async () => {
    const failure = Object.assign(new Error("duplicate"), {
      code: "23505",
      constraint: "paca_environment_scope_pkey",
    });
    const database = {
      transaction: async () => {
        throw failure;
      },
    };
    const repository = new PostgresEnvironmentScopeRepository(database as never);

    await expect(
      repository.create({
        ...environment,
        gatewayReference: `paca-env-${ENVIRONMENT_ID}`,
      }),
    ).rejects.toBe(failure);
  });
});
