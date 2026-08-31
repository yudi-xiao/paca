import type { AppBindings } from "../bindings";
import { withDatabase } from "../database";
import { PostgresAttachmentRepository } from "./postgres-repository";
import type {
  AttachmentFile,
  AttachmentObjectInspection,
  AttachmentRepository,
  TaskAttachment,
} from "./service";

export class RuntimeAttachmentRepository implements AttachmentRepository {
  constructor(private readonly env: AppBindings) {}

  createPending(input: {
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
    return this.withRepository((repository) => repository.createPending(input));
  }

  setMultipartUploadId(
    projectId: string,
    taskId: string,
    fileId: string,
    uploadedBy: string,
    uploadId: string,
  ): Promise<AttachmentFile> {
    return this.withRepository((repository) =>
      repository.setMultipartUploadId(projectId, taskId, fileId, uploadedBy, uploadId),
    );
  }

  findUpload(
    projectId: string,
    taskId: string,
    fileId: string,
    uploadedBy: string,
  ): Promise<AttachmentFile> {
    return this.withRepository((repository) =>
      repository.findUpload(projectId, taskId, fileId, uploadedBy),
    );
  }

  markFailed(projectId: string, taskId: string, fileId: string): Promise<void> {
    return this.withRepository((repository) => repository.markFailed(projectId, taskId, fileId));
  }

  complete(input: {
    projectId: string;
    taskId: string;
    fileId: string;
    actorUserId: string;
    inspection: AttachmentObjectInspection;
  }): Promise<TaskAttachment> {
    return this.withRepository((repository) => repository.complete(input));
  }

  list(projectId: string, taskId: string, deleted = false): Promise<TaskAttachment[]> {
    return this.withRepository((repository) => repository.list(projectId, taskId, deleted));
  }

  findAttachment(projectId: string, taskId: string, attachmentId: string): Promise<TaskAttachment> {
    return this.withRepository((repository) =>
      repository.findAttachment(projectId, taskId, attachmentId),
    );
  }

  findDeletedAttachment(
    projectId: string,
    taskId: string,
    attachmentId: string,
  ): Promise<TaskAttachment> {
    return this.withRepository((repository) =>
      repository.findDeletedAttachment(projectId, taskId, attachmentId),
    );
  }

  softDelete(
    projectId: string,
    taskId: string,
    attachmentId: string,
    actorUserId: string,
  ): Promise<void> {
    return this.withRepository((repository) =>
      repository.softDelete(projectId, taskId, attachmentId, actorUserId),
    );
  }

  restore(
    projectId: string,
    taskId: string,
    attachmentId: string,
    actorUserId: string,
    now: Date,
  ): Promise<TaskAttachment> {
    return this.withRepository((repository) =>
      repository.restore(projectId, taskId, attachmentId, actorUserId, now),
    );
  }

  private withRepository<T>(
    operation: (repository: PostgresAttachmentRepository) => Promise<T>,
  ): Promise<T> {
    return withDatabase(this.env, (database) =>
      operation(new PostgresAttachmentRepository(database)),
    );
  }
}
