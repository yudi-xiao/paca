import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, notExists, or } from "drizzle-orm";

import type { PacaDatabase } from "../database";
import { pacaFiles, pacaTaskAttachments } from "../db/schema";
import type { AttachmentCleanupRepository } from "./cleanup";
import type { AttachmentFile, AttachmentUploadStatus } from "./service";

type FileRow = typeof pacaFiles.$inferSelect;

function attachmentFileFromRow(row: FileRow): AttachmentFile {
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    taskId: row.taskId,
    storageKey: row.storageKey,
    bucket: row.bucket,
    fileName: row.fileName,
    contentType: row.contentType,
    declaredSize: row.declaredSize,
    actualSize: row.actualSize,
    sha256: row.sha256,
    etag: row.etag,
    uploadStatus: row.uploadStatus as AttachmentUploadStatus,
    multipartUploadId: row.multipartUploadId,
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
    purgeStartedAt: row.purgeStartedAt,
  };
}

export class PostgresAttachmentCleanupRepository implements AttachmentCleanupRepository {
  constructor(private readonly database: PacaDatabase) {}

  claimDeleted(now: Date, staleBefore: Date, limit: number): Promise<AttachmentFile[]> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({ file: pacaFiles })
        .from(pacaTaskAttachments)
        .innerJoin(pacaFiles, eq(pacaTaskAttachments.fileId, pacaFiles.id))
        .where(
          and(
            isNotNull(pacaTaskAttachments.deletedAt),
            lte(pacaTaskAttachments.purgeAfter, now),
            or(
              isNull(pacaTaskAttachments.purgeStartedAt),
              lt(pacaTaskAttachments.purgeStartedAt, staleBefore),
            ),
            or(isNull(pacaFiles.purgeStartedAt), lt(pacaFiles.purgeStartedAt, staleBefore)),
          ),
        )
        .orderBy(asc(pacaTaskAttachments.purgeAfter))
        .limit(limit)
        .for("update", { skipLocked: true });
      const fileIds = rows.map(({ file }) => file.id);
      if (fileIds.length === 0) return [];

      await transaction
        .update(pacaTaskAttachments)
        .set({ purgeStartedAt: now })
        .where(inArray(pacaTaskAttachments.fileId, fileIds));
      const claimed = await transaction
        .update(pacaFiles)
        .set({ purgeStartedAt: now })
        .where(inArray(pacaFiles.id, fileIds))
        .returning();
      return claimed.map(attachmentFileFromRow);
    });
  }

  claimAbandoned(
    now: Date,
    failedBefore: Date,
    pendingBefore: Date,
    staleBefore: Date,
    limit: number,
  ): Promise<AttachmentFile[]> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select()
        .from(pacaFiles)
        .where(
          and(
            or(isNull(pacaFiles.purgeStartedAt), lt(pacaFiles.purgeStartedAt, staleBefore)),
            notExists(
              transaction
                .select({ id: pacaTaskAttachments.id })
                .from(pacaTaskAttachments)
                .where(eq(pacaTaskAttachments.fileId, pacaFiles.id)),
            ),
            or(
              and(eq(pacaFiles.uploadStatus, "failed"), lt(pacaFiles.updatedAt, failedBefore)),
              and(eq(pacaFiles.uploadStatus, "pending"), lt(pacaFiles.createdAt, pendingBefore)),
            ),
          ),
        )
        .orderBy(asc(pacaFiles.createdAt))
        .limit(limit)
        .for("update", { skipLocked: true });
      const fileIds = rows.map((file) => file.id);
      if (fileIds.length === 0) return [];

      const claimed = await transaction
        .update(pacaFiles)
        .set({ purgeStartedAt: now })
        .where(inArray(pacaFiles.id, fileIds))
        .returning();
      return claimed.map(attachmentFileFromRow);
    });
  }

  async complete(fileIds: string[], claimedAt: Date): Promise<void> {
    if (fileIds.length === 0) return;
    await this.database
      .delete(pacaFiles)
      .where(and(inArray(pacaFiles.id, fileIds), eq(pacaFiles.purgeStartedAt, claimedAt)));
  }

  async release(fileIds: string[], claimedAt: Date): Promise<void> {
    if (fileIds.length === 0) return;
    await this.database.transaction(async (transaction) => {
      await transaction
        .update(pacaTaskAttachments)
        .set({ purgeStartedAt: null })
        .where(
          and(
            inArray(pacaTaskAttachments.fileId, fileIds),
            eq(pacaTaskAttachments.purgeStartedAt, claimedAt),
          ),
        );
      await transaction
        .update(pacaFiles)
        .set({ purgeStartedAt: null })
        .where(and(inArray(pacaFiles.id, fileIds), eq(pacaFiles.purgeStartedAt, claimedAt)));
    });
  }
}
