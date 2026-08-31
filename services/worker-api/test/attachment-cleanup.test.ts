import { describe, expect, it, vi } from "vitest";

import {
  ATTACHMENT_CLEANUP_BATCH_SIZE,
  ATTACHMENT_CLEANUP_CLAIM_STALE_MS,
  type AttachmentCleanupRepository,
  AttachmentCleanupService,
  FAILED_UPLOAD_RETENTION_MS,
  PENDING_UPLOAD_RETENTION_MS,
} from "../src/attachment/cleanup";
import type { AttachmentFile } from "../src/attachment/service";

function file(id: string): AttachmentFile {
  return {
    id,
    organizationId: "paca-default",
    projectId: "6bdb7f3a-e59d-4826-8383-0104192157a8",
    taskId: "c9d8cdf1-b208-4c87-b71f-cf4cdf2d373a",
    storageKey: `attachments/${id}`,
    bucket: "paca-task-attachments",
    fileName: `${id}.txt`,
    contentType: "text/plain",
    declaredSize: 4,
    actualSize: 4,
    sha256: "a".repeat(64),
    etag: "etag",
    uploadStatus: "uploaded",
    multipartUploadId: null,
    uploadedBy: "user-1",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    completedAt: new Date("2026-08-01T00:00:00.000Z"),
    purgeStartedAt: null,
  };
}

function repository(overrides: Partial<AttachmentCleanupRepository> = {}) {
  return {
    claimDeleted: vi.fn(async () => [file("deleted")]),
    claimAbandoned: vi.fn(async () => [file("abandoned")]),
    complete: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    ...overrides,
  } satisfies AttachmentCleanupRepository;
}

describe("attachment cleanup", () => {
  it("claims bounded work, deletes R2 objects, then removes database metadata", async () => {
    const now = new Date("2026-08-28T12:00:00.000Z");
    const repo = repository();
    const deleteObject = vi.fn(async () => undefined);
    const result = await new AttachmentCleanupService(repo, { delete: deleteObject }).run(now);

    const expectedLimit = Math.floor(ATTACHMENT_CLEANUP_BATCH_SIZE / 2);
    expect(repo.claimDeleted).toHaveBeenCalledWith(
      now,
      new Date(now.getTime() - ATTACHMENT_CLEANUP_CLAIM_STALE_MS),
      expectedLimit,
    );
    expect(repo.claimAbandoned).toHaveBeenCalledWith(
      now,
      new Date(now.getTime() - FAILED_UPLOAD_RETENTION_MS),
      new Date(now.getTime() - PENDING_UPLOAD_RETENTION_MS),
      new Date(now.getTime() - ATTACHMENT_CLEANUP_CLAIM_STALE_MS),
      expectedLimit,
    );
    expect(deleteObject).toHaveBeenCalledTimes(2);
    expect(repo.complete).toHaveBeenCalledWith(["deleted", "abandoned"], now);
    expect(repo.release).toHaveBeenCalledWith([], now);
    expect(result).toEqual({ claimed: 2, purged: 2, failed: 0 });
  });

  it("releases only failed claims so a later scheduled run can retry them", async () => {
    const now = new Date("2026-08-28T12:00:00.000Z");
    const repo = repository();
    const result = await new AttachmentCleanupService(repo, {
      delete: async (candidate) => {
        if (candidate.id === "abandoned") throw new Error("R2 unavailable");
      },
    }).run(now);

    expect(repo.complete).toHaveBeenCalledWith(["deleted"], now);
    expect(repo.release).toHaveBeenCalledWith(["abandoned"], now);
    expect(result).toEqual({ claimed: 2, purged: 1, failed: 1 });
  });
});
