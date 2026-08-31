import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { AttachmentRuntime } from "../src/attachment/runtime";
import type { AttachmentFile, TaskAttachment } from "../src/attachment/service";
import type { AppBindings } from "../src/bindings";

const projectId = "6bdb7f3a-e59d-4826-8383-0104192157a8";
const taskId = "c9d8cdf1-b208-4c87-b71f-cf4cdf2d373a";
const fileId = "7b2646f8-da57-4f5a-8f54-1407ca012c84";
const attachmentId = "e0db602e-41c8-4cc1-b504-8d972ecb7e44";

const file: AttachmentFile = {
  id: fileId,
  organizationId: "paca-default",
  projectId,
  taskId,
  storageKey: "organizations/paca-default/projects/p/tasks/t/attachments/f/report.pdf",
  bucket: "paca-task-attachments",
  fileName: "报告.pdf",
  contentType: "application/pdf",
  declaredSize: 4,
  actualSize: 4,
  sha256: "a".repeat(64),
  etag: "etag",
  uploadStatus: "uploaded",
  multipartUploadId: null,
  uploadedBy: "user-1",
  createdAt: new Date("2026-08-28T00:00:00.000Z"),
  updatedAt: new Date("2026-08-28T00:01:00.000Z"),
  completedAt: new Date("2026-08-28T00:01:00.000Z"),
  purgeStartedAt: null,
};

const attachment: TaskAttachment = {
  id: attachmentId,
  projectId,
  taskId,
  fileId,
  createdBy: "user-1",
  createdAt: new Date("2026-08-28T00:01:00.000Z"),
  deletedAt: null,
  purgeAfter: null,
  file,
};

function bindings(): AppBindings {
  return { ENVIRONMENT: "test" } as AppBindings;
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

function runtime(overrides: Partial<AttachmentRuntime> = {}): AttachmentRuntime {
  return {
    initiate: async () => ({
      fileId,
      isMultipart: false,
      uploadUrl: `/api/v1/projects/${projectId}/tasks/${taskId}/attachments/uploads/${fileId}`,
    }),
    upload: async () => ({ etag: '"single"' }),
    uploadPart: async () => ({ etag: "part-1" }),
    complete: async () => attachment,
    cancel: async () => undefined,
    list: async () => [attachment],
    get: async () => attachment,
    content: async () => ({
      attachment,
      object: {
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("test"));
            controller.close();
          },
        }),
        etag: '"etag"',
        size: 4,
        range: null,
      },
    }),
    delete: async () => undefined,
    restore: async () => attachment,
    ...overrides,
  };
}

describe("task attachment HTTP contract", () => {
  it("initiates a protected same-origin upload with the authenticated actor", async () => {
    const initiate = vi.fn(runtime().initiate);
    const authorizeProjectPermission = authorize();
    const app = createApp({
      attachments: runtime({ initiate }),
      authorizeProjectPermission,
      log: vi.fn(),
    });

    const response = await app.request(
      `/api/v1/projects/${projectId}/tasks/${taskId}/attachments/initiate-upload`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          file_name: "report.pdf",
          content_type: "application/pdf",
          file_size: 4,
        }),
      },
      bindings(),
    );

    expect(response.status).toBe(201);
    expect(authorizeProjectPermission).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      projectId,
      { tasks: ["write"] },
    );
    expect(initiate).toHaveBeenCalledWith(
      expect.anything(),
      projectId,
      taskId,
      "user-1",
      { fileName: "report.pdf", contentType: "application/pdf", fileSize: 4 },
      `/api/v1/projects/${projectId}/tasks/${taskId}/attachments/uploads`,
    );
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { file_id: fileId, is_multipart: false },
    });
  });

  it("streams an upload body to the protected R2 runtime and returns its ETag", async () => {
    const upload = vi.fn(runtime().upload);
    const app = createApp({
      attachments: runtime({ upload }),
      authorizeProjectPermission: authorize(),
      log: vi.fn(),
    });
    const response = await app.request(
      `/api/v1/projects/${projectId}/tasks/${taskId}/attachments/uploads/${fileId}`,
      {
        method: "PUT",
        headers: { "content-length": "4", "content-type": "application/pdf" },
        body: "test",
      },
      bindings(),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("etag")).toBe('"single"');
    expect(upload).toHaveBeenCalledWith(
      expect.anything(),
      projectId,
      taskId,
      fileId,
      "user-1",
      4,
      expect.any(ReadableStream),
    );
  });

  it("cancels a pending upload with write permission and the authenticated actor", async () => {
    const cancel = vi.fn(runtime().cancel);
    const authorizeProjectPermission = authorize();
    const app = createApp({
      attachments: runtime({ cancel }),
      authorizeProjectPermission,
      log: vi.fn(),
    });
    const response = await app.request(
      `/api/v1/projects/${projectId}/tasks/${taskId}/attachments/uploads/${fileId}`,
      { method: "DELETE" },
      bindings(),
    );

    expect(response.status).toBe(204);
    expect(authorizeProjectPermission).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      projectId,
      { tasks: ["write"] },
    );
    expect(cancel).toHaveBeenCalledWith(expect.anything(), projectId, taskId, fileId, "user-1");
  });

  it("lists and completes attachments using the existing React response shape", async () => {
    const app = createApp({
      attachments: runtime(),
      authorizeProjectPermission: authorize(),
      log: vi.fn(),
    });
    const listResponse = await app.request(
      `/api/v1/projects/${projectId}/tasks/${taskId}/attachments`,
      {},
      bindings(),
    );
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      data: {
        items: [
          {
            id: attachmentId,
            task_id: taskId,
            file_id: fileId,
            file: { file_name: "报告.pdf", file_size: 4, sha256: "a".repeat(64) },
          },
        ],
      },
    });

    const completeResponse = await app.request(
      `/api/v1/projects/${projectId}/tasks/${taskId}/attachments/complete-upload`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file_id: fileId }),
      },
      bindings(),
    );
    expect(completeResponse.status).toBe(201);
  });

  it("lists recently deleted attachments and restores one with write permission", async () => {
    const deletedAttachment = {
      ...attachment,
      deletedAt: new Date("2026-08-28T01:00:00.000Z"),
      purgeAfter: new Date("2026-09-27T01:00:00.000Z"),
    };
    const list = vi.fn(async () => [deletedAttachment]);
    const restore = vi.fn(async () => attachment);
    const authorizeProjectPermission = authorize();
    const app = createApp({
      attachments: runtime({ list, restore }),
      authorizeProjectPermission,
      log: vi.fn(),
    });

    const listResponse = await app.request(
      `/api/v1/projects/${projectId}/tasks/${taskId}/attachments?deleted=true`,
      {},
      bindings(),
    );
    expect(listResponse.status).toBe(200);
    expect(list).toHaveBeenCalledWith(expect.anything(), projectId, taskId, true);
    await expect(listResponse.json()).resolves.toMatchObject({
      data: {
        items: [
          {
            id: attachmentId,
            deleted_at: "2026-08-28T01:00:00.000Z",
            purge_after: "2026-09-27T01:00:00.000Z",
          },
        ],
      },
    });

    const restoreResponse = await app.request(
      `/api/v1/projects/${projectId}/tasks/${taskId}/attachments/${attachmentId}/restore`,
      { method: "POST" },
      bindings(),
    );
    expect(restoreResponse.status).toBe(200);
    expect(restore).toHaveBeenCalledWith(
      expect.anything(),
      projectId,
      taskId,
      attachmentId,
      "user-1",
    );
    expect(authorizeProjectPermission).toHaveBeenLastCalledWith(
      expect.any(Request),
      expect.anything(),
      projectId,
      { tasks: ["write"] },
    );
  });

  it("returns a protected content URL and streams safe inline content with no sniffing", async () => {
    const app = createApp({
      attachments: runtime(),
      authorizeProjectPermission: authorize(),
      log: vi.fn(),
    });
    const urlResponse = await app.request(
      `/api/v1/projects/${projectId}/tasks/${taskId}/attachments/${attachmentId}/download-url`,
      {},
      bindings(),
    );
    await expect(urlResponse.json()).resolves.toMatchObject({
      data: {
        url: `/api/v1/projects/${projectId}/tasks/${taskId}/attachments/${attachmentId}/content`,
      },
    });

    const contentResponse = await app.request(
      `/api/v1/projects/${projectId}/tasks/${taskId}/attachments/${attachmentId}/content`,
      {},
      bindings(),
    );
    expect(contentResponse.status).toBe(200);
    expect(contentResponse.headers.get("content-type")).toBe("application/pdf");
    expect(contentResponse.headers.get("content-disposition")).toContain("inline");
    expect(contentResponse.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    expect(contentResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect(contentResponse.headers.get("cache-control")).toBe("private, no-store");
    await expect(contentResponse.text()).resolves.toBe("test");
  });

  it("forces unsafe content types to download and supports byte-range responses", async () => {
    const unsafeAttachment = {
      ...attachment,
      file: { ...file, fileName: "page.html", contentType: "text/html" },
    };
    const content = vi.fn(async () => ({
      attachment: unsafeAttachment,
      object: {
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("es"));
            controller.close();
          },
        }),
        etag: '"etag"',
        size: 4,
        range: { offset: 1, length: 2 },
      },
    }));
    const app = createApp({
      attachments: runtime({ content }),
      authorizeProjectPermission: authorize(),
      log: vi.fn(),
    });
    const response = await app.request(
      `/api/v1/projects/${projectId}/tasks/${taskId}/attachments/${attachmentId}/content`,
      { headers: { range: "bytes=1-2" } },
      bindings(),
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 1-2/4");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(content).toHaveBeenCalledWith(
      expect.anything(),
      projectId,
      taskId,
      attachmentId,
      "bytes=1-2",
    );
  });
});
