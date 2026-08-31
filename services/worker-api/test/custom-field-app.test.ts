import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import type { AppBindings } from "../src/bindings";
import type { CustomFieldRuntime } from "../src/custom-field/runtime";
import type { CustomFieldDefinition } from "../src/custom-field/service";

const projectId = "6bdb7f3a-e59d-4826-8383-0104192157a8";
const field: CustomFieldDefinition = {
  id: "16b0fcb9-2069-4cf3-b619-211632a49aa4",
  projectId,
  fieldKey: "release_channel",
  displayName: "Release channel",
  fieldType: "select",
  options: ["stable", "beta"],
  isRequired: false,
  createdAt: new Date("2026-08-28T00:00:00.000Z"),
  updatedAt: new Date("2026-08-28T00:00:00.000Z"),
};

function bindings(): AppBindings {
  return { ENVIRONMENT: "test" } as AppBindings;
}

function customFields(overrides: Partial<CustomFieldRuntime> = {}): CustomFieldRuntime {
  return {
    list: async () => [field],
    get: async () => field,
    create: async () => field,
    update: async () => field,
    delete: async () => undefined,
    ...overrides,
  };
}

function authorize() {
  return vi.fn(async () => ({
    authenticated: true as const,
    userId: "user-1",
    decision: {
      scopeExists: true,
      allowed: true,
      grants: [{ resource: "tasks" as const, action: "*" }],
    },
  }));
}

describe("custom field HTTP contract", () => {
  it("lists fields behind tasks.read", async () => {
    const list = vi.fn(customFields().list);
    const authorizeProjectPermission = authorize();
    const app = createApp({
      authorizeProjectPermission,
      customFields: customFields({ list }),
      log: vi.fn(),
    });
    const response = await app.request(
      `/api/v1/projects/${projectId}/custom-fields`,
      {},
      bindings(),
    );
    expect(response.status).toBe(200);
    expect(authorizeProjectPermission).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      projectId,
      { tasks: ["read"] },
    );
    await expect(response.json()).resolves.toMatchObject({
      data: { items: [{ field_key: "release_channel", field_type: "select" }] },
    });
  });

  it("creates fields behind tasks.write with the React API shape", async () => {
    const create = vi.fn(customFields().create);
    const app = createApp({
      authorizeProjectPermission: authorize(),
      customFields: customFields({ create }),
      log: vi.fn(),
    });
    const response = await app.request(
      `/api/v1/projects/${projectId}/custom-fields`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          field_key: "release_channel",
          display_name: "Release channel",
          field_type: "select",
          options: ["stable", "beta"],
        }),
      },
      bindings(),
    );
    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith(expect.anything(), projectId, {
      fieldKey: "release_channel",
      displayName: "Release channel",
      fieldType: "select",
      options: ["stable", "beta"],
      isRequired: undefined,
    });
  });
});
