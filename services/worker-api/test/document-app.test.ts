import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import type { AppBindings } from "../src/bindings";
import type { DocumentRuntime } from "../src/document/runtime";
import type { PacaDocument } from "../src/document/service";

const projectId = "6bdb7f3a-e59d-4826-8383-0104192157a8";
const documentId = "44444444-4444-4444-8444-444444444444";

const document: PacaDocument = {
  id: documentId,
  projectId,
  title: "Architecture",
  content: [{ type: "paragraph", content: [] }],
  contentVersion: 3,
  position: 2,
  createdBy: "user-1",
  updatedBy: "user-1",
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T01:00:00.000Z"),
};

function bindings(): AppBindings {
  return { ENVIRONMENT: "test" } as AppBindings;
}

function documents(overrides: Partial<DocumentRuntime> = {}): DocumentRuntime {
  return {
    list: async () => [document],
    get: async () => document,
    create: async () => document,
    update: async () => document,
    archive: async () => undefined,
    collaborationStatus: async () => ({
      initialized: true,
      updateCount: 2,
      updateBytes: 128,
      checkpointBytes: 256,
    }),
    bootstrapCollaboration: async () => ({ initialized: true }),
    invalidateCollaboration: async () => 0,
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
      grants: [{ resource: "docs" as const, action: "*" }],
    },
  }));
}

describe("document HTTP contract", () => {
  it("lists documents behind docs.read using the existing React envelope", async () => {
    const list = vi.fn(documents().list);
    const authorizeProjectPermission = authorize();
    const app = createApp({
      authorizeProjectPermission,
      documents: documents({ list }),
      log: vi.fn(),
    });

    const response = await app.request(`/api/v1/projects/${projectId}/docs`, {}, bindings());

    expect(response.status).toBe(200);
    expect(authorizeProjectPermission).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      projectId,
      { docs: ["read"] },
    );
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        items: [
          {
            id: documentId,
            title: "Architecture",
            content_version: 3,
            folder_id: null,
          },
        ],
      },
    });
  });

  it("creates and updates documents with the authenticated permission actor", async () => {
    const create = vi.fn(documents().create);
    const update = vi.fn(documents().update);
    const app = createApp({
      authorizeProjectPermission: authorize(),
      documents: documents({ create, update }),
      log: vi.fn(),
    });

    const createResponse = await app.request(
      `/api/v1/projects/${projectId}/docs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Architecture", content: null }),
      },
      bindings(),
    );
    const updateResponse = await app.request(
      `/api/v1/projects/${projectId}/docs/${documentId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: [{ type: "paragraph", content: [] }] }),
      },
      bindings(),
    );

    expect(createResponse.status).toBe(201);
    expect(create).toHaveBeenCalledWith(expect.anything(), projectId, "user-1", {
      title: "Architecture",
      content: null,
    });
    expect(updateResponse.status).toBe(200);
    expect(update).toHaveBeenCalledWith(expect.anything(), projectId, documentId, "user-1", {
      content: [{ type: "paragraph", content: [] }],
    });
  });

  it("reports collaboration persistence and bootstraps only validated binary updates", async () => {
    const collaborationStatus = vi.fn(documents().collaborationStatus);
    const bootstrapCollaboration = vi.fn(documents().bootstrapCollaboration);
    const app = createApp({
      authorizeProjectPermission: authorize(),
      documents: documents({ collaborationStatus, bootstrapCollaboration }),
      log: vi.fn(),
    });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const updateBase64 = btoa(String.fromCharCode(...bytes));

    const statusResponse = await app.request(
      `/api/v1/projects/${projectId}/docs/${documentId}/collaboration`,
      {},
      bindings(),
    );
    const bootstrapResponse = await app.request(
      `/api/v1/projects/${projectId}/docs/${documentId}/collaboration/bootstrap`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ update_base64: updateBase64 }),
      },
      bindings(),
    );

    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({
      data: { initialized: true, update_count: 2, checkpoint_bytes: 256 },
    });
    expect(bootstrapResponse.status).toBe(200);
    const update = bootstrapCollaboration.mock.calls[0]?.[2];
    expect(update ? [...new Uint8Array(update)] : null).toEqual([...bytes]);
  });

  it("rejects malformed collaboration bootstraps before calling Durable Objects", async () => {
    const bootstrapCollaboration = vi.fn(documents().bootstrapCollaboration);
    const app = createApp({
      authorizeProjectPermission: authorize(),
      documents: documents({ bootstrapCollaboration }),
      log: vi.fn(),
    });

    const response = await app.request(
      `/api/v1/projects/${projectId}/docs/${documentId}/collaboration/bootstrap`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ update_base64: "not base64" }),
      },
      bindings(),
    );

    expect(response.status).toBe(400);
    expect(bootstrapCollaboration).not.toHaveBeenCalled();
  });

  it("archives a document through the docs.write boundary", async () => {
    const archive = vi.fn(documents().archive);
    const authorizeProjectPermission = authorize();
    const app = createApp({
      authorizeProjectPermission,
      documents: documents({ archive }),
      log: vi.fn(),
    });

    const response = await app.request(
      `/api/v1/projects/${projectId}/docs/${documentId}`,
      { method: "DELETE" },
      bindings(),
    );

    expect(response.status).toBe(204);
    expect(archive).toHaveBeenCalledWith(expect.anything(), projectId, documentId, "user-1");
    expect(authorizeProjectPermission).toHaveBeenLastCalledWith(
      expect.any(Request),
      expect.anything(),
      projectId,
      { docs: ["write"] },
    );
  });
});
