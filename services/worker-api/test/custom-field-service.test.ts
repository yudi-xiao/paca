import { describe, expect, it, vi } from "vitest";

import {
  type CustomFieldDefinition,
  type CustomFieldRepository,
  CustomFieldService,
  customFieldErrorCodes,
} from "../src/custom-field/service";

const field: CustomFieldDefinition = {
  id: "16b0fcb9-2069-4cf3-b619-211632a49aa4",
  projectId: "6bdb7f3a-e59d-4826-8383-0104192157a8",
  fieldKey: "release_channel",
  displayName: "Release channel",
  fieldType: "select",
  options: ["stable", "beta"],
  isRequired: false,
  createdAt: new Date("2026-08-28T00:00:00.000Z"),
  updatedAt: new Date("2026-08-28T00:00:00.000Z"),
};

function repository(overrides: Partial<CustomFieldRepository> = {}): CustomFieldRepository {
  return {
    list: async () => [field],
    findById: async () => field,
    create: async () => field,
    update: async () => field,
    delete: async () => undefined,
    ...overrides,
  };
}

describe("custom field service", () => {
  it("normalizes keys, names, and select options", async () => {
    const create = vi.fn(repository().create);
    const service = new CustomFieldService(repository({ create }));

    await service.create(field.projectId, {
      fieldKey: " Release_Channel ",
      displayName: "  Release channel ",
      fieldType: "select",
      options: [" stable ", "stable", "beta"],
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: field.projectId,
        fieldKey: "release_channel",
        displayName: "Release channel",
        options: ["stable", "beta"],
      }),
    );
  });

  it("rejects malformed keys and options on scalar fields", () => {
    const service = new CustomFieldService(repository());
    expect(() =>
      service.create(field.projectId, {
        fieldKey: "bad key",
        displayName: "Bad",
        fieldType: "text",
      }),
    ).toThrowError(expect.objectContaining({ code: customFieldErrorCodes.keyInvalid }));
    expect(() =>
      service.create(field.projectId, {
        fieldKey: "notes",
        displayName: "Notes",
        fieldType: "text",
        options: ["not-applicable"],
      }),
    ).toThrowError(expect.objectContaining({ code: customFieldErrorCodes.optionsInvalid }));
  });

  it("keeps field key and type immutable during updates", async () => {
    const update = vi.fn(repository().update);
    const service = new CustomFieldService(repository({ update }));
    await service.update(field.projectId, field.id, {
      displayName: " Delivery channel ",
      options: ["stable", "nightly"],
      isRequired: true,
    });
    expect(update).toHaveBeenCalledWith(field.projectId, field.id, {
      displayName: "Delivery channel",
      options: ["stable", "nightly"],
      isRequired: true,
    });
  });
});
