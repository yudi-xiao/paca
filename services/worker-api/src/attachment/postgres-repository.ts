import { and, asc, desc, eq, getTableColumns, gt, isNotNull, isNull } from "drizzle-orm";

import type { PacaDatabase } from "../database";
import {
  pacaFiles,
  pacaProjectMembers,
  pacaProjects,
  pacaTaskActivities,
  pacaTaskAttachments,
  pacaTasks,
} from "../db/schema";
import {
  ATTACHMENT_DELETE_RETENTION_MS,
  AttachmentError,
  type AttachmentFile,
  type AttachmentObjectInspection,
  type AttachmentRepository,
  type AttachmentUploadStatus,
  attachmentErrorCodes,
  type TaskAttachment,
} from "./service";

type FileRow = typeof pacaFiles.$inferSelect;

function fileFromRow(row: FileRow): AttachmentFile {
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

function attachmentFromRow(row: {
  id: string;
  projectId: string;
  taskId: string;
  fileId: string;
  createdBy: string | null;
  createdAt: Date;
  deletedAt: Date | null;
  purgeAfter: Date | null;
  file: FileRow;
}): TaskAttachment {
  return {
    id: row.id,
    projectId: row.projectId,
    taskId: row.taskId,
    fileId: row.fileId,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
    purgeAfter: row.purgeAfter,
    file: fileFromRow(row.file),
  };
}

export class PostgresAttachmentRepository implements AttachmentRepository {
  constructor(private readonly database: PacaDatabase) {}

  async createPending(input: {
    fileId: string;
    projectId: string;
    taskId: string;
    uploadedBy: string;
    fileName: string;
    contentType: string;
    declaredSize: number;
    storageKey: (organizationId: string) => string;
    bucket: string;
  }): Promise<AttachmentFile> {
    return this.database.transaction(async (transaction) => {
      const [scope] = await transaction
        .select({ organizationId: pacaProjects.organizationId })
        .from(pacaTasks)
        .innerJoin(pacaProjects, eq(pacaTasks.projectId, pacaProjects.id))
        .where(
          and(
            eq(pacaTasks.id, input.taskId),
            eq(pacaTasks.projectId, input.projectId),
            isNull(pacaTasks.deletedAt),
            eq(pacaProjects.status, "active"),
          ),
        )
        .limit(1);
      if (!scope) throw new AttachmentError(attachmentErrorCodes.taskNotFound);

      const [created] = await transaction
        .insert(pacaFiles)
        .values({
          id: input.fileId,
          organizationId: scope.organizationId,
          projectId: input.projectId,
          taskId: input.taskId,
          storageKey: input.storageKey(scope.organizationId),
          bucket: input.bucket,
          fileName: input.fileName,
          contentType: input.contentType,
          declaredSize: input.declaredSize,
          uploadedBy: input.uploadedBy,
        })
        .returning();
      if (!created) throw new Error("ATTACHMENT_FILE_CREATE_FAILED");
      return fileFromRow(created);
    });
  }

  async setMultipartUploadId(
    projectId: string,
    taskId: string,
    fileId: string,
    uploadedBy: string,
    uploadId: string,
  ): Promise<AttachmentFile> {
    const [updated] = await this.database
      .update(pacaFiles)
      .set({ multipartUploadId: uploadId, updatedAt: new Date() })
      .where(
        and(
          eq(pacaFiles.id, fileId),
          eq(pacaFiles.projectId, projectId),
          eq(pacaFiles.taskId, taskId),
          eq(pacaFiles.uploadedBy, uploadedBy),
          eq(pacaFiles.uploadStatus, "pending"),
          isNull(pacaFiles.multipartUploadId),
        ),
      )
      .returning();
    if (!updated) throw new AttachmentError(attachmentErrorCodes.fileNotFound);
    return fileFromRow(updated);
  }

  async findUpload(
    projectId: string,
    taskId: string,
    fileId: string,
    uploadedBy: string,
  ): Promise<AttachmentFile> {
    const [row] = await this.database
      .select()
      .from(pacaFiles)
      .where(
        and(
          eq(pacaFiles.id, fileId),
          eq(pacaFiles.projectId, projectId),
          eq(pacaFiles.taskId, taskId),
          eq(pacaFiles.uploadedBy, uploadedBy),
          eq(pacaFiles.uploadStatus, "pending"),
        ),
      )
      .limit(1);
    if (!row) throw new AttachmentError(attachmentErrorCodes.fileNotFound);
    return fileFromRow(row);
  }

  async markFailed(projectId: string, taskId: string, fileId: string): Promise<void> {
    await this.database
      .update(pacaFiles)
      .set({ uploadStatus: "failed", updatedAt: new Date() })
      .where(
        and(
          eq(pacaFiles.id, fileId),
          eq(pacaFiles.projectId, projectId),
          eq(pacaFiles.taskId, taskId),
          eq(pacaFiles.uploadStatus, "pending"),
        ),
      );
  }

  async complete(input: {
    projectId: string;
    taskId: string;
    fileId: string;
    actorUserId: string;
    inspection: AttachmentObjectInspection;
  }): Promise<TaskAttachment> {
    return this.database.transaction(async (transaction) => {
      const [file] = await transaction
        .select()
        .from(pacaFiles)
        .where(
          and(
            eq(pacaFiles.id, input.fileId),
            eq(pacaFiles.projectId, input.projectId),
            eq(pacaFiles.taskId, input.taskId),
            eq(pacaFiles.uploadedBy, input.actorUserId),
          ),
        )
        .for("update")
        .limit(1);
      if (!file) throw new AttachmentError(attachmentErrorCodes.fileNotFound);
      if (file.uploadStatus !== "pending") {
        throw new AttachmentError(attachmentErrorCodes.uploadNotPending);
      }

      const completedAt = new Date();
      const [updatedFile] = await transaction
        .update(pacaFiles)
        .set({
          actualSize: input.inspection.size,
          sha256: input.inspection.sha256,
          etag: input.inspection.etag,
          uploadStatus: "uploaded",
          multipartUploadId: null,
          completedAt,
          updatedAt: completedAt,
        })
        .where(eq(pacaFiles.id, input.fileId))
        .returning();
      if (!updatedFile) throw new Error("ATTACHMENT_FILE_COMPLETE_FAILED");

      const attachmentId = crypto.randomUUID();
      const [created] = await transaction
        .insert(pacaTaskAttachments)
        .values({
          id: attachmentId,
          projectId: input.projectId,
          taskId: input.taskId,
          fileId: input.fileId,
          createdBy: input.actorUserId,
        })
        .returning();
      if (!created) throw new Error("ATTACHMENT_CREATE_FAILED");

      await this.recordActivity(transaction, {
        projectId: input.projectId,
        taskId: input.taskId,
        actorUserId: input.actorUserId,
        activityType: "task.attachment.added",
        content: {
          attachment_id: attachmentId,
          file_id: input.fileId,
          file_name: file.fileName,
          file_size: input.inspection.size,
          sha256: input.inspection.sha256,
        },
      });

      return attachmentFromRow({ ...created, file: updatedFile });
    });
  }

  async list(projectId: string, taskId: string, deleted = false): Promise<TaskAttachment[]> {
    await this.requireTask(projectId, taskId);
    const rows = await this.database
      .select({ ...getTableColumns(pacaTaskAttachments), file: getTableColumns(pacaFiles) })
      .from(pacaTaskAttachments)
      .innerJoin(pacaFiles, eq(pacaTaskAttachments.fileId, pacaFiles.id))
      .where(
        and(
          eq(pacaTaskAttachments.projectId, projectId),
          eq(pacaTaskAttachments.taskId, taskId),
          deleted
            ? and(
                isNotNull(pacaTaskAttachments.deletedAt),
                isNull(pacaTaskAttachments.purgeStartedAt),
                gt(pacaTaskAttachments.purgeAfter, new Date()),
              )
            : isNull(pacaTaskAttachments.deletedAt),
          eq(pacaFiles.uploadStatus, "uploaded"),
        ),
      )
      .orderBy(deleted ? desc(pacaTaskAttachments.deletedAt) : asc(pacaTaskAttachments.createdAt));
    return rows.map(attachmentFromRow);
  }

  async findAttachment(
    projectId: string,
    taskId: string,
    attachmentId: string,
  ): Promise<TaskAttachment> {
    const [row] = await this.database
      .select({ ...getTableColumns(pacaTaskAttachments), file: getTableColumns(pacaFiles) })
      .from(pacaTaskAttachments)
      .innerJoin(pacaFiles, eq(pacaTaskAttachments.fileId, pacaFiles.id))
      .where(
        and(
          eq(pacaTaskAttachments.id, attachmentId),
          eq(pacaTaskAttachments.projectId, projectId),
          eq(pacaTaskAttachments.taskId, taskId),
          isNull(pacaTaskAttachments.deletedAt),
          eq(pacaFiles.uploadStatus, "uploaded"),
        ),
      )
      .limit(1);
    if (!row) throw new AttachmentError(attachmentErrorCodes.attachmentNotFound);
    return attachmentFromRow(row);
  }

  async findDeletedAttachment(
    projectId: string,
    taskId: string,
    attachmentId: string,
  ): Promise<TaskAttachment> {
    const [row] = await this.database
      .select({ ...getTableColumns(pacaTaskAttachments), file: getTableColumns(pacaFiles) })
      .from(pacaTaskAttachments)
      .innerJoin(pacaFiles, eq(pacaTaskAttachments.fileId, pacaFiles.id))
      .where(
        and(
          eq(pacaTaskAttachments.id, attachmentId),
          eq(pacaTaskAttachments.projectId, projectId),
          eq(pacaTaskAttachments.taskId, taskId),
          isNotNull(pacaTaskAttachments.deletedAt),
          isNull(pacaTaskAttachments.purgeStartedAt),
          gt(pacaTaskAttachments.purgeAfter, new Date()),
          eq(pacaFiles.uploadStatus, "uploaded"),
        ),
      )
      .limit(1);
    if (!row) throw new AttachmentError(attachmentErrorCodes.attachmentRestoreUnavailable);
    return attachmentFromRow(row);
  }

  async softDelete(
    projectId: string,
    taskId: string,
    attachmentId: string,
    actorUserId: string,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const [current] = await transaction
        .select({
          id: pacaTaskAttachments.id,
          fileId: pacaTaskAttachments.fileId,
          fileName: pacaFiles.fileName,
        })
        .from(pacaTaskAttachments)
        .innerJoin(pacaFiles, eq(pacaTaskAttachments.fileId, pacaFiles.id))
        .where(
          and(
            eq(pacaTaskAttachments.id, attachmentId),
            eq(pacaTaskAttachments.projectId, projectId),
            eq(pacaTaskAttachments.taskId, taskId),
            isNull(pacaTaskAttachments.deletedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (!current) throw new AttachmentError(attachmentErrorCodes.attachmentNotFound);

      const deletedAt = new Date();
      const [deleted] = await transaction
        .update(pacaTaskAttachments)
        .set({
          deletedAt,
          purgeAfter: new Date(deletedAt.getTime() + ATTACHMENT_DELETE_RETENTION_MS),
          purgeStartedAt: null,
        })
        .where(and(eq(pacaTaskAttachments.id, attachmentId), isNull(pacaTaskAttachments.deletedAt)))
        .returning({ id: pacaTaskAttachments.id });
      if (!deleted) throw new AttachmentError(attachmentErrorCodes.attachmentNotFound);

      await this.recordActivity(transaction, {
        projectId,
        taskId,
        actorUserId,
        activityType: "task.attachment.removed",
        content: {
          attachment_id: attachmentId,
          file_id: current.fileId,
          file_name: current.fileName,
        },
      });
    });
  }

  async restore(
    projectId: string,
    taskId: string,
    attachmentId: string,
    actorUserId: string,
    now: Date,
  ): Promise<TaskAttachment> {
    return this.database.transaction(async (transaction) => {
      const [current] = await transaction
        .select({ ...getTableColumns(pacaTaskAttachments), file: getTableColumns(pacaFiles) })
        .from(pacaTaskAttachments)
        .innerJoin(pacaFiles, eq(pacaTaskAttachments.fileId, pacaFiles.id))
        .where(
          and(
            eq(pacaTaskAttachments.id, attachmentId),
            eq(pacaTaskAttachments.projectId, projectId),
            eq(pacaTaskAttachments.taskId, taskId),
            isNotNull(pacaTaskAttachments.deletedAt),
            isNull(pacaTaskAttachments.purgeStartedAt),
            gt(pacaTaskAttachments.purgeAfter, now),
          ),
        )
        .for("update")
        .limit(1);
      if (!current) {
        throw new AttachmentError(attachmentErrorCodes.attachmentRestoreUnavailable);
      }

      const [restored] = await transaction
        .update(pacaTaskAttachments)
        .set({ deletedAt: null, purgeAfter: null, purgeStartedAt: null })
        .where(
          and(
            eq(pacaTaskAttachments.id, attachmentId),
            isNotNull(pacaTaskAttachments.deletedAt),
            isNull(pacaTaskAttachments.purgeStartedAt),
          ),
        )
        .returning();
      if (!restored) {
        throw new AttachmentError(attachmentErrorCodes.attachmentRestoreUnavailable);
      }

      await this.recordActivity(transaction, {
        projectId,
        taskId,
        actorUserId,
        activityType: "task.attachment.restored",
        content: {
          attachment_id: attachmentId,
          file_id: current.fileId,
          file_name: current.file.fileName,
        },
      });
      return attachmentFromRow({ ...restored, file: current.file });
    });
  }

  private async requireTask(projectId: string, taskId: string): Promise<void> {
    const [task] = await this.database
      .select({ id: pacaTasks.id })
      .from(pacaTasks)
      .where(
        and(
          eq(pacaTasks.id, taskId),
          eq(pacaTasks.projectId, projectId),
          isNull(pacaTasks.deletedAt),
        ),
      )
      .limit(1);
    if (!task) throw new AttachmentError(attachmentErrorCodes.taskNotFound);
  }

  private async recordActivity(
    database: Pick<PacaDatabase, "insert" | "select">,
    input: {
      projectId: string;
      taskId: string;
      actorUserId: string;
      activityType: string;
      content: Record<string, unknown>;
    },
  ): Promise<void> {
    const [member] = await database
      .select({ id: pacaProjectMembers.id })
      .from(pacaProjectMembers)
      .where(
        and(
          eq(pacaProjectMembers.projectId, input.projectId),
          eq(pacaProjectMembers.userId, input.actorUserId),
        ),
      )
      .limit(1);
    await database.insert(pacaTaskActivities).values({
      id: crypto.randomUUID(),
      projectId: input.projectId,
      taskId: input.taskId,
      actorType: "user",
      actorId: input.actorUserId,
      actorUserId: input.actorUserId,
      actorMemberId: member?.id ?? null,
      actorAgentId: null,
      activityType: input.activityType,
      content: input.content,
    });
  }
}
