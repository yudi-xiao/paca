import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import type { AppBindings } from "../src/bindings";
import type { BrandingRuntime } from "../src/branding/runtime";
import {
  BrandingError,
  type BrandingSettings,
  type BrandingUpload,
  brandingErrorCodes,
} from "../src/branding/service";

const fileId = "7b2646f8-da57-4f5a-8f54-1407ca012c84";
const actorId = "user-1";

const logo: BrandingUpload = {
  id: fileId,
  slot: "logo",
  storageKey: `branding/logo/${fileId}/logo.png`,
  fileName: "logo.png",
  contentType: "image/png",
  declaredSize: 4,
  actualSize: 4,
  etag: "etag-1",
  status: "active",
  uploadedBy: actorId,
  cleanupClaimedAt: null,
  createdAt: new Date("2026-09-07T00:00:00.000Z"),
  updatedAt: new Date("2026-09-07T00:01:00.000Z"),
};

const settings: BrandingSettings = {
  logo,
  favicon: null,
  brandName: "Paca Internal",
  primaryColorLight: "#5a9e1c",
  primaryColorDark: "#9ed957",
  updatedAt: new Date("2026-09-07T00:01:00.000Z"),
  updatedBy: actorId,
};

function bindings(overrides: Partial<AppBindings> = {}): AppBindings {
  return { ENVIRONMENT: "test", ...overrides } as AppBindings;
}

function authorize() {
  return vi.fn(async () => ({
    authenticated: true as const,
    userId: actorId,
    allowed: true,
    grants: [{ resource: "settings" as const, action: "write" }],
  }));
}

function runtime(overrides: Partial<BrandingRuntime> = {}): BrandingRuntime {
  return {
    get: async () => settings,
    initiate: async () => ({
      fileId,
      uploadUrl: `/api/v1/admin/settings/logo/avatar/uploads/${fileId}`,
    }),
    upload: async () => ({ etag: '"etag-1"' }),
    complete: async () => settings,
    remove: async () => ({ ...settings, logo: null }),
    update: async () => settings,
    image: async () => ({
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("logo"));
          controller.close();
        },
      }),
      contentType: "image/png",
      etag: '"etag-1"',
      size: 4,
    }),
    cleanup: async () => ({ claimed: 0, purged: 0, failed: 0 }),
    ...overrides,
  };
}

describe("workspace branding HTTP contract", () => {
  it("serves public settings and immutable current images", async () => {
    const app = createApp({ branding: runtime(), log: vi.fn() });
    const response = await app.request("/api/v1/branding", {}, bindings());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    await expect(response.json()).resolves.toMatchObject({
      data: {
        brand_name: "Paca Internal",
        logo_url: `/api/v1/branding/images/logo/${fileId}`,
        logo_thumb_url: `/api/v1/branding/images/logo/${fileId}`,
        favicon_url: null,
      },
    });

    const image = await app.request(`/api/v1/branding/images/logo/${fileId}`, {}, bindings());
    expect(image.status).toBe(200);
    expect(image.headers.get("cache-control")).toContain("immutable");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(image.text()).resolves.toBe("logo");
  });

  it("uses settings.write and the authenticated actor for text updates", async () => {
    const update = vi.fn(runtime().update);
    const authorizeSystemPermission = authorize();
    const app = createApp({
      branding: runtime({ update }),
      authorizeSystemPermission,
      log: vi.fn(),
    });
    const response = await app.request(
      "/api/v1/admin/settings",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          brand_name: "Paca Internal",
          primary_color_light: "#5a9e1c",
          primary_color_dark: "#9ed957",
        }),
      },
      bindings(),
    );

    expect(response.status).toBe(200);
    expect(authorizeSystemPermission).toHaveBeenCalledWith(expect.any(Request), expect.anything(), {
      settings: ["write"],
    });
    expect(update).toHaveBeenCalledWith(
      expect.anything(),
      {
        brandName: "Paca Internal",
        primaryColorLight: "#5a9e1c",
        primaryColorDark: "#9ed957",
      },
      actorId,
    );
  });

  it("runs the complete same-origin logo upload contract", async () => {
    const initiate = vi.fn(runtime().initiate);
    const upload = vi.fn(runtime().upload);
    const complete = vi.fn(runtime().complete);
    const remove = vi.fn(runtime().remove);
    const app = createApp({
      branding: runtime({ initiate, upload, complete, remove }),
      authorizeSystemPermission: authorize(),
      log: vi.fn(),
    });

    const initiated = await app.request(
      "/api/v1/admin/settings/logo/avatar/initiate-upload",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file_name: "logo.png", content_type: "image/png", file_size: 4 }),
      },
      bindings(),
    );
    expect(initiated.status).toBe(201);
    expect(initiate).toHaveBeenCalledWith(
      expect.anything(),
      "logo",
      actorId,
      { fileName: "logo.png", contentType: "image/png", fileSize: 4 },
      "/api/v1/admin/settings/logo/avatar/uploads",
    );

    const uploaded = await app.request(
      `/api/v1/admin/settings/logo/avatar/uploads/${fileId}`,
      {
        method: "PUT",
        headers: { "content-length": "4", "content-type": "image/png" },
        body: "logo",
      },
      bindings(),
    );
    expect(uploaded.status).toBe(204);
    expect(upload).toHaveBeenCalledWith(
      expect.anything(),
      fileId,
      actorId,
      4,
      expect.any(ReadableStream),
    );

    const completed = await app.request(
      "/api/v1/admin/settings/logo/avatar/complete-upload",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file_id: fileId }),
      },
      bindings(),
    );
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toMatchObject({
      data: {
        avatar_url: `/api/v1/branding/images/logo/${fileId}`,
        avatar_thumb_url: `/api/v1/branding/images/logo/${fileId}`,
      },
    });

    const removed = await app.request(
      "/api/v1/admin/settings/logo/avatar",
      { method: "DELETE" },
      bindings(),
    );
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toMatchObject({
      data: { avatar_url: null, avatar_thumb_url: null },
    });
  });

  it("maps missing images and rejects cookie mutations without Origin", async () => {
    const app = createApp({
      branding: runtime({
        image: async () => {
          throw new BrandingError(brandingErrorCodes.imageNotFound);
        },
      }),
      authorizeSystemPermission: authorize(),
      log: vi.fn(),
    });
    const missing = await app.request(`/api/v1/branding/images/logo/${fileId}`, {}, bindings());
    expect(missing.status).toBe(404);

    const rejected = await app.request(
      "/api/v1/admin/settings",
      {
        method: "PATCH",
        headers: { cookie: "better-auth.session_token=test", "content-type": "application/json" },
        body: JSON.stringify({
          brand_name: null,
          primary_color_light: null,
          primary_color_dark: null,
        }),
      },
      bindings({ TRUSTED_ORIGINS: "https://paca.test" }),
    );
    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toMatchObject({ code: "MISSING_ORIGIN" });
  });
});
