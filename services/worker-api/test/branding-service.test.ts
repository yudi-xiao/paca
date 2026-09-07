import { describe, expect, it, vi } from "vitest";

import {
  BrandingError,
  type BrandingObjectStore,
  type BrandingRepository,
  BrandingService,
  type BrandingSettings,
  type BrandingUpload,
  brandingErrorCodes,
} from "../src/branding/service";

const actorId = "user-1";
const fileId = "7b2646f8-da57-4f5a-8f54-1407ca012c84";
const now = new Date("2026-09-07T00:00:00.000Z");
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function upload(overrides: Partial<BrandingUpload> = {}): BrandingUpload {
  return {
    id: fileId,
    slot: "logo",
    storageKey: `branding/logo/${fileId}/logo.png`,
    fileName: "logo.png",
    contentType: "image/png",
    declaredSize: png.byteLength,
    actualSize: null,
    etag: null,
    status: "pending",
    uploadedBy: actorId,
    cleanupClaimedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function settings(active: BrandingUpload | null = null): BrandingSettings {
  return {
    logo: active,
    favicon: null,
    brandName: null,
    primaryColorLight: null,
    primaryColorDark: null,
    updatedAt: now,
    updatedBy: null,
  };
}

function repository(overrides: Partial<BrandingRepository> = {}): BrandingRepository {
  let current = upload();
  return {
    get: async () => settings(current.status === "active" ? current : null),
    createPending: async (input) => {
      current = upload({ ...input });
      return current;
    },
    findForUpload: async () => current,
    markUploaded: async (_id, _actor, inspection) => {
      current = { ...current, ...inspection, status: "uploaded" };
      return current;
    },
    activate: async () => {
      current = { ...current, status: "active" };
      return settings(current);
    },
    clear: async () => settings(),
    update: async (input, updatedBy, updatedAt) => ({
      ...settings(),
      ...input,
      updatedBy,
      updatedAt,
    }),
    findActiveImage: async () => current,
    claimCleanup: async () => [],
    completeCleanup: async () => undefined,
    releaseCleanup: async () => undefined,
    ...overrides,
  };
}

function objects(overrides: Partial<BrandingObjectStore> = {}): BrandingObjectStore {
  return {
    put: async () => ({ actualSize: png.byteLength, etag: "etag-1" }),
    inspect: async () => ({ bytes: png, actualSize: png.byteLength, etag: "etag-1" }),
    get: async () => ({
      body: new ReadableStream(),
      contentType: "image/png",
      etag: '"etag-1"',
      size: png.byteLength,
    }),
    delete: async () => undefined,
    ...overrides,
  };
}

function body(bytes = png): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe("branding service", () => {
  it("normalizes metadata and creates a same-origin upload session", async () => {
    const createPending = vi.fn(repository().createPending);
    const service = new BrandingService(repository({ createPending }), objects(), () => now);
    const session = await service.initiate(
      "logo",
      actorId,
      { fileName: "../ 品牌.png ", contentType: "IMAGE/PNG", fileSize: png.byteLength },
      "/api/v1/admin/settings/logo/avatar/uploads",
    );

    expect(session.uploadUrl).toBe(`/api/v1/admin/settings/logo/avatar/uploads/${session.fileId}`);
    expect(createPending).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: "品牌.png",
        contentType: "image/png",
        declaredSize: png.byteLength,
        uploadedBy: actorId,
      }),
    );
  });

  it("streams, verifies and activates a valid image", async () => {
    const repo = repository();
    const service = new BrandingService(repo, objects(), () => now);
    const uploaded = await service.upload(fileId, actorId, png.byteLength, body());
    expect(uploaded).toEqual({ etag: "etag-1" });
    await expect(service.complete(fileId, actorId)).resolves.toMatchObject({
      logo: { id: fileId, status: "active" },
    });
  });

  it("rejects invalid metadata, body sizes and forged image bytes", async () => {
    const service = new BrandingService(repository(), objects(), () => now);
    await expect(
      service.initiate(
        "logo",
        actorId,
        { fileName: "..", contentType: "image/png", fileSize: 8 },
        "/uploads",
      ),
    ).rejects.toMatchObject({ code: brandingErrorCodes.fileNameInvalid });
    await expect(
      service.initiate(
        "logo",
        actorId,
        { fileName: "x.svg", contentType: "image/svg+xml", fileSize: 8 },
        "/uploads",
      ),
    ).rejects.toMatchObject({ code: brandingErrorCodes.contentTypeInvalid });
    await expect(service.upload(fileId, actorId, 7, body())).rejects.toMatchObject({
      code: brandingErrorCodes.uploadSizeMismatch,
    });

    const uploaded = upload({ status: "uploaded", actualSize: 8, etag: "etag-1" });
    const forged = new BrandingService(
      repository({ findForUpload: async () => uploaded }),
      objects({
        inspect: async () => ({ bytes: new Uint8Array(16), actualSize: 8, etag: "etag-1" }),
      }),
      () => now,
    );
    await expect(forged.complete(fileId, actorId)).rejects.toMatchObject({
      code: brandingErrorCodes.imageInvalid,
    });
  });

  it("normalizes brand values and purges only successfully deleted objects", async () => {
    const first = upload({ id: crypto.randomUUID(), status: "obsolete" });
    const second = upload({ id: crypto.randomUUID(), status: "obsolete" });
    const completeCleanup = vi.fn(async () => undefined);
    const releaseCleanup = vi.fn(async () => undefined);
    const update = vi.fn(repository().update);
    const service = new BrandingService(
      repository({
        update,
        claimCleanup: async () => [first, second],
        completeCleanup,
        releaseCleanup,
      }),
      objects({
        delete: async (candidate) => {
          if (candidate.id === second.id) throw new BrandingError(brandingErrorCodes.imageNotFound);
        },
      }),
      () => now,
    );

    await service.update(
      { brandName: "  Paca 内部  ", primaryColorLight: "#AABBCC", primaryColorDark: "" },
      actorId,
    );
    expect(update).toHaveBeenCalledWith(
      { brandName: "Paca 内部", primaryColorLight: "#aabbcc", primaryColorDark: null },
      actorId,
      now,
    );
    await expect(service.cleanup()).resolves.toEqual({ claimed: 2, purged: 1, failed: 1 });
    expect(completeCleanup).toHaveBeenCalledWith([first.id], now);
    expect(releaseCleanup).toHaveBeenCalledWith([second.id], now);
  });
});
