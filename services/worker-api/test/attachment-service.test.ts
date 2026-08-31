import { describe, expect, it, vi } from "vitest";

import {
  ATTACHMENT_MAX_SIZE,
  ATTACHMENT_PART_SIZE,
  AttachmentError,
  type AttachmentFile,
  type AttachmentObjectStore,
  type AttachmentRepository,
  AttachmentService,
  attachmentErrorCodes,
  expectedPartSize,
  parseAttachmentRange,
  type TaskAttachment,
} from "../src/attachment/service";

const projectId = "6bdb7f3a-e59d-4826-8383-0104192157a8";
const taskId = "c9d8cdf1-b208-4c87-b71f-cf4cdf2d373a";
const userId = "user-1";

function fileFixture(overrides: Partial<AttachmentFile> = {}): AttachmentFile {
  return {
    id: "7b2646f8-da57-4f5a-8f54-1407ca012c84",
    organizationId: "paca-default",
    projectId,
    taskId,
    storageKey:
      "organizations/paca-default/projects/project/tasks/task/attachments/file/report.pdf",
    bucket: "paca-task-attachments",
    fileName: "report.pdf",
    contentType: "application/pdf",
    declaredSize: 4,
    actualSize: null,
    sha256: null,
    etag: null,
    uploadStatus: "pending",
    multipartUploadId: null,
    uploadedBy: userId,
    createdAt: new Date("2026-08-28T00:00:00.000Z"),
    updatedAt: new Date("2026-08-28T00:00:00.000Z"),
    completedAt: null,
    purgeStartedAt: null,
    ...overrides,
  };
}

function attachmentFixture(file = fileFixture()): TaskAttachment {
  return {
    id: "e0db602e-41c8-4cc1-b504-8d972ecb7e44",
    projectId,
    taskId,
    fileId: file.id,
    createdBy: userId,
    createdAt: new Date("2026-08-28T00:01:00.000Z"),
    deletedAt: null,
    purgeAfter: null,
    file,
  };
}

function repository(overrides: Partial<AttachmentRepository> = {}): AttachmentRepository {
  let current = fileFixture();
  return {
    createPending: async (input) => {
      current = fileFixture({
        id: input.fileId,
        projectId: input.projectId,
        taskId: input.taskId,
        uploadedBy: input.uploadedBy,
        fileName: input.fileName,
        contentType: input.contentType,
        declaredSize: input.declaredSize,
        storageKey: input.storageKey("paca-default"),
        bucket: input.bucket,
      });
      return current;
    },
    setMultipartUploadId: async (_projectId, _taskId, _fileId, _userId, uploadId) => {
      current = { ...current, multipartUploadId: uploadId };
      return current;
    },
    findUpload: async () => current,
    markFailed: async () => {
      current = { ...current, uploadStatus: "failed" };
    },
    complete: async (input) =>
      attachmentFixture({
        ...current,
        actualSize: input.inspection.size,
        sha256: input.inspection.sha256,
        etag: input.inspection.etag,
        uploadStatus: "uploaded",
        multipartUploadId: null,
        completedAt: new Date(),
      }),
    list: async () => [],
    findAttachment: async () => attachmentFixture(current),
    findDeletedAttachment: async () => attachmentFixture({ ...current, uploadStatus: "uploaded" }),
    softDelete: async () => undefined,
    restore: async () => attachmentFixture(current),
    ...overrides,
  };
}

function objectStore(overrides: Partial<AttachmentObjectStore> = {}): AttachmentObjectStore {
  return {
    createMultipart: async () => "upload-1",
    put: async () => ({ etag: '"single"' }),
    putPart: async (_file, partNumber) => ({ etag: `part-${partNumber}` }),
    completeMultipart: async () => ({ etag: '"multipart"' }),
    abort: async () => undefined,
    inspect: async (file) => ({ size: file.declaredSize, etag: "etag", sha256: "a".repeat(64) }),
    get: async (file, range) => ({
      body: new ReadableStream(),
      etag: '"etag"',
      size: file.declaredSize,
      range: range ?? null,
    }),
    delete: async () => undefined,
    exists: async () => true,
    ...overrides,
  };
}

function body(): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      controller.close();
    },
  });
}

describe("attachment service", () => {
  it("creates a scoped single-part upload session without exposing R2 credentials", async () => {
    const createPending = vi.fn(repository().createPending);
    const service = new AttachmentService(repository({ createPending }), objectStore());

    const session = await service.initiate(
      projectId,
      taskId,
      userId,
      {
        fileName: "../quarterly report.pdf",
        contentType: "application/pdf",
        fileSize: 4,
      },
      `/api/v1/projects/${projectId}/tasks/${taskId}/attachments/uploads`,
    );

    expect(session).toMatchObject({ isMultipart: false });
    expect(session.uploadUrl).toBe(
      `/api/v1/projects/${projectId}/tasks/${taskId}/attachments/uploads/${session.fileId}`,
    );
    expect(createPending).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: "quarterly report.pdf",
        contentType: "application/pdf",
        declaredSize: 4,
        projectId,
        taskId,
        uploadedBy: userId,
      }),
    );
    const keyBuilder = createPending.mock.calls[0]?.[0].storageKey;
    expect(keyBuilder?.("paca/default")).toContain("organizations/paca~2Fdefault/projects/");
    expect(keyBuilder?.("paca/default")).toContain("quarterly_report.pdf");
  });

  it("creates an R2 multipart session and validates every expected part", async () => {
    const createMultipart = vi.fn(async () => "upload-123");
    const completeMultipart = vi.fn(async () => ({ etag: '"multipart"' }));
    const inspect = vi
      .fn<AttachmentObjectStore["inspect"]>()
      .mockRejectedValueOnce(new AttachmentError(attachmentErrorCodes.objectMissing))
      .mockResolvedValue({
        size: ATTACHMENT_PART_SIZE + 1,
        etag: "etag",
        sha256: "a".repeat(64),
      });
    const repo = repository();
    const service = new AttachmentService(
      repo,
      objectStore({ createMultipart, completeMultipart, inspect }),
    );
    const size = ATTACHMENT_PART_SIZE + 1;

    const session = await service.initiate(
      projectId,
      taskId,
      userId,
      { fileName: "archive.zip", contentType: "application/zip", fileSize: size },
      "/uploads",
    );
    expect(session.multipart).toEqual({
      uploadId: "upload-123",
      parts: [
        { partNumber: 1, uploadUrl: `/uploads/${session.fileId}/parts/1` },
        { partNumber: 2, uploadUrl: `/uploads/${session.fileId}/parts/2` },
      ],
    });
    expect(expectedPartSize(size, 1)).toBe(ATTACHMENT_PART_SIZE);
    expect(expectedPartSize(size, 2)).toBe(1);

    const completed = await service.complete(
      projectId,
      taskId,
      session.fileId,
      userId,
      "upload-123",
      [
        { partNumber: 2, etag: "part-2" },
        { partNumber: 1, etag: "part-1" },
      ],
    );
    expect(completeMultipart).toHaveBeenCalledWith(
      expect.objectContaining({ multipartUploadId: "upload-123" }),
      [
        { partNumber: 1, etag: "part-1" },
        { partNumber: 2, etag: "part-2" },
      ],
    );
    expect(completed.file.sha256).toBe("a".repeat(64));
  });

  it("retries multipart completion after R2 succeeded without completing the upload twice", async () => {
    const completeMultipart = vi.fn(async () => ({ etag: '"multipart"' }));
    const size = ATTACHMENT_PART_SIZE + 1;
    const file = fileFixture({ declaredSize: size, multipartUploadId: "upload-123" });
    const service = new AttachmentService(
      repository({ findUpload: async () => file }),
      objectStore({
        completeMultipart,
        inspect: async () => ({ size, etag: "etag", sha256: "b".repeat(64) }),
      }),
    );

    const completed = await service.complete(projectId, taskId, file.id, userId, "upload-123", [
      { partNumber: 1, etag: "part-1" },
      { partNumber: 2, etag: "part-2" },
    ]);

    expect(completeMultipart).not.toHaveBeenCalled();
    expect(completed.file.sha256).toBe("b".repeat(64));
  });

  it("rejects invalid metadata, oversized files and mismatched request bodies", async () => {
    const service = new AttachmentService(repository(), objectStore());
    await expect(
      service.initiate(
        projectId,
        taskId,
        userId,
        { fileName: "../", contentType: "text/plain", fileSize: 1 },
        "/uploads",
      ),
    ).rejects.toMatchObject({ code: attachmentErrorCodes.fileNameInvalid });
    await expect(
      service.initiate(
        projectId,
        taskId,
        userId,
        {
          fileName: "huge.bin",
          contentType: "application/octet-stream",
          fileSize: ATTACHMENT_MAX_SIZE + 1,
        },
        "/uploads",
      ),
    ).rejects.toMatchObject({ code: attachmentErrorCodes.sizeInvalid });
    await expect(
      service.upload(projectId, taskId, fileFixture().id, userId, 3, body()),
    ).rejects.toMatchObject({ code: attachmentErrorCodes.uploadSizeMismatch });
  });

  it("deletes and fails a completed object whose actual size does not match metadata", async () => {
    const markFailed = vi.fn(async () => undefined);
    const deleteObject = vi.fn(async () => undefined);
    const service = new AttachmentService(
      repository({ markFailed }),
      objectStore({
        inspect: async () => ({ size: 5, etag: "etag", sha256: "b".repeat(64) }),
        delete: deleteObject,
      }),
    );
    await expect(
      service.complete(projectId, taskId, fileFixture().id, userId, null, []),
    ).rejects.toMatchObject({ code: attachmentErrorCodes.uploadSizeMismatch });
    expect(deleteObject).toHaveBeenCalledOnce();
    expect(markFailed).toHaveBeenCalledOnce();
  });

  it("aborts a pending object before marking its metadata failed", async () => {
    const events: string[] = [];
    const file = fileFixture({ multipartUploadId: "upload-123" });
    const service = new AttachmentService(
      repository({
        findUpload: async () => file,
        markFailed: async () => {
          events.push("failed");
        },
      }),
      objectStore({
        abort: async (pending) => {
          expect(pending.multipartUploadId).toBe("upload-123");
          events.push("aborted");
        },
      }),
    );

    await service.cancel(projectId, taskId, file.id, userId);
    expect(events).toEqual(["aborted", "failed"]);
  });

  it("restores a deleted attachment only while its R2 object still exists", async () => {
    const now = new Date("2026-08-28T12:00:00.000Z");
    const deleted = {
      ...attachmentFixture(fileFixture({ uploadStatus: "uploaded" })),
      deletedAt: new Date("2026-08-27T12:00:00.000Z"),
      purgeAfter: new Date("2026-09-26T12:00:00.000Z"),
    };
    const findDeletedAttachment = vi.fn(async () => deleted);
    const restore = vi.fn(async () => ({ ...deleted, deletedAt: null, purgeAfter: null }));
    const exists = vi.fn(async () => true);
    const service = new AttachmentService(
      repository({ findDeletedAttachment, restore }),
      objectStore({ exists }),
    );

    const restored = await service.restore(projectId, taskId, deleted.id, userId, now);

    expect(exists).toHaveBeenCalledWith(deleted.file);
    expect(restore).toHaveBeenCalledWith(projectId, taskId, deleted.id, userId, now);
    expect(restored.deletedAt).toBeNull();
  });

  it("does not restore metadata after the underlying R2 object is missing", async () => {
    const deleted = {
      ...attachmentFixture(fileFixture({ uploadStatus: "uploaded" })),
      deletedAt: new Date("2026-08-27T12:00:00.000Z"),
      purgeAfter: new Date("2026-09-26T12:00:00.000Z"),
    };
    const restore = vi.fn(repository().restore);
    const service = new AttachmentService(
      repository({ findDeletedAttachment: async () => deleted, restore }),
      objectStore({ exists: async () => false }),
    );

    await expect(service.restore(projectId, taskId, deleted.id, userId)).rejects.toMatchObject({
      code: attachmentErrorCodes.objectMissing,
    });
    expect(restore).not.toHaveBeenCalled();
  });

  it("parses bounded single byte ranges and rejects multiple or unsatisfiable ranges", () => {
    expect(parseAttachmentRange(undefined, 100)).toBeUndefined();
    expect(parseAttachmentRange("bytes=10-19", 100)).toEqual({ offset: 10, length: 10 });
    expect(parseAttachmentRange("bytes=90-", 100)).toEqual({ offset: 90, length: 10 });
    expect(parseAttachmentRange("bytes=-7", 100)).toEqual({ offset: 93, length: 7 });
    expect(() => parseAttachmentRange("bytes=100-101", 100)).toThrow(AttachmentError);
    expect(() => parseAttachmentRange("bytes=0-1,4-5", 100)).toThrow(AttachmentError);
  });
});
