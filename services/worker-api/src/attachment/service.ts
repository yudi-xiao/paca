export const attachmentErrorCodes = {
  attachmentNotFound: "ATTACHMENT_NOT_FOUND",
  attachmentRestoreUnavailable: "ATTACHMENT_RESTORE_UNAVAILABLE",
  contentTypeInvalid: "ATTACHMENT_CONTENT_TYPE_INVALID",
  fileNameInvalid: "ATTACHMENT_FILE_NAME_INVALID",
  fileNotFound: "ATTACHMENT_FILE_NOT_FOUND",
  multipartInvalid: "ATTACHMENT_MULTIPART_INVALID",
  objectMissing: "ATTACHMENT_OBJECT_MISSING",
  rangeInvalid: "ATTACHMENT_RANGE_INVALID",
  sizeInvalid: "ATTACHMENT_SIZE_INVALID",
  taskNotFound: "TASK_NOT_FOUND",
  uploadForbidden: "ATTACHMENT_UPLOAD_FORBIDDEN",
  uploadNotPending: "ATTACHMENT_UPLOAD_NOT_PENDING",
  uploadSizeMismatch: "ATTACHMENT_UPLOAD_SIZE_MISMATCH",
} as const;

export type AttachmentErrorCode = (typeof attachmentErrorCodes)[keyof typeof attachmentErrorCodes];

export class AttachmentError extends Error {
  constructor(
    readonly code: AttachmentErrorCode,
    message = code,
  ) {
    super(message);
    this.name = "AttachmentError";
  }
}

export const attachmentUploadStatus = {
  failed: "failed",
  pending: "pending",
  uploaded: "uploaded",
} as const;

export type AttachmentUploadStatus =
  (typeof attachmentUploadStatus)[keyof typeof attachmentUploadStatus];

export const ATTACHMENT_MULTIPART_THRESHOLD = 5 * 1024 * 1024;
export const ATTACHMENT_PART_SIZE = 5 * 1024 * 1024;
export const ATTACHMENT_MAX_SIZE = 512 * 1024 * 1024;
export const ATTACHMENT_BUCKET = "paca-task-attachments";
export const ATTACHMENT_DELETE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export type AttachmentFile = {
  id: string;
  organizationId: string;
  projectId: string;
  taskId: string;
  storageKey: string;
  bucket: string;
  fileName: string;
  contentType: string;
  declaredSize: number;
  actualSize: number | null;
  sha256: string | null;
  etag: string | null;
  uploadStatus: AttachmentUploadStatus;
  multipartUploadId: string | null;
  uploadedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  purgeStartedAt: Date | null;
};

export type TaskAttachment = {
  id: string;
  projectId: string;
  taskId: string;
  fileId: string;
  createdBy: string | null;
  createdAt: Date;
  deletedAt: Date | null;
  purgeAfter: Date | null;
  file: AttachmentFile;
};

export type AttachmentInitiateInput = {
  fileName: string;
  contentType: string;
  fileSize: number;
};

export type AttachmentUploadSession = {
  fileId: string;
  isMultipart: boolean;
  uploadUrl?: string;
  multipart?: {
    uploadId: string;
    parts: Array<{ partNumber: number; uploadUrl: string }>;
  };
};

export type AttachmentCompletedPart = {
  partNumber: number;
  etag: string;
};

export type AttachmentObjectInspection = {
  size: number;
  etag: string;
  sha256: string;
};

export type AttachmentObject = {
  body: ReadableStream;
  etag: string;
  size: number;
  range: { offset: number; length: number } | null;
};

export function parseAttachmentRange(
  value: string | undefined,
  size: number,
): { offset: number; length: number } | undefined {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size < 1) {
    throw new AttachmentError(attachmentErrorCodes.rangeInvalid);
  }

  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) {
      throw new AttachmentError(attachmentErrorCodes.rangeInvalid);
    }
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    throw new AttachmentError(attachmentErrorCodes.rangeInvalid);
  }
  const end = Math.min(requestedEnd, size - 1);
  return { offset: start, length: end - start + 1 };
}

export type AttachmentRepository = {
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
  }): Promise<AttachmentFile>;
  setMultipartUploadId(
    projectId: string,
    taskId: string,
    fileId: string,
    uploadedBy: string,
    uploadId: string,
  ): Promise<AttachmentFile>;
  findUpload(
    projectId: string,
    taskId: string,
    fileId: string,
    uploadedBy: string,
  ): Promise<AttachmentFile>;
  markFailed(projectId: string, taskId: string, fileId: string): Promise<void>;
  complete(input: {
    projectId: string;
    taskId: string;
    fileId: string;
    actorUserId: string;
    inspection: AttachmentObjectInspection;
  }): Promise<TaskAttachment>;
  list(projectId: string, taskId: string, deleted?: boolean): Promise<TaskAttachment[]>;
  findAttachment(projectId: string, taskId: string, attachmentId: string): Promise<TaskAttachment>;
  findDeletedAttachment(
    projectId: string,
    taskId: string,
    attachmentId: string,
  ): Promise<TaskAttachment>;
  softDelete(
    projectId: string,
    taskId: string,
    attachmentId: string,
    actorUserId: string,
  ): Promise<void>;
  restore(
    projectId: string,
    taskId: string,
    attachmentId: string,
    actorUserId: string,
    now: Date,
  ): Promise<TaskAttachment>;
};

export type AttachmentObjectStore = {
  createMultipart(file: AttachmentFile): Promise<string>;
  put(file: AttachmentFile, body: ReadableStream): Promise<{ etag: string }>;
  putPart(
    file: AttachmentFile,
    partNumber: number,
    body: ReadableStream,
  ): Promise<{ etag: string }>;
  completeMultipart(
    file: AttachmentFile,
    parts: AttachmentCompletedPart[],
  ): Promise<{ etag: string }>;
  abort(file: AttachmentFile): Promise<void>;
  exists(file: AttachmentFile): Promise<boolean>;
  inspect(file: AttachmentFile): Promise<AttachmentObjectInspection>;
  get(file: AttachmentFile, range?: { offset: number; length: number }): Promise<AttachmentObject>;
  delete(file: AttachmentFile): Promise<void>;
};

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function normalizeFileName(value: string): string {
  const basename = value.replaceAll("\\", "/").split("/").at(-1)?.trim() ?? "";
  const normalized = [...basename]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    })
    .join("");
  if (!normalized || normalized === "." || normalized === ".." || utf8Length(normalized) > 255) {
    throw new AttachmentError(attachmentErrorCodes.fileNameInvalid);
  }
  return normalized;
}

function normalizeContentType(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 255 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(normalized)) {
    throw new AttachmentError(attachmentErrorCodes.contentTypeInvalid);
  }
  return normalized;
}

function objectKeySegment(value: string): string {
  return encodeURIComponent(value).replaceAll("%", "~");
}

function fileKeySegment(value: string): string {
  const compact = value.replace(/\s+/g, "_");
  return objectKeySegment(compact).slice(0, 360) || "file";
}

export function expectedPartSize(fileSize: number, partNumber: number): number {
  const partCount = Math.ceil(fileSize / ATTACHMENT_PART_SIZE);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > partCount) {
    throw new AttachmentError(attachmentErrorCodes.multipartInvalid);
  }
  if (partNumber < partCount) return ATTACHMENT_PART_SIZE;
  return fileSize - ATTACHMENT_PART_SIZE * (partCount - 1);
}

export class AttachmentService {
  constructor(
    private readonly repository: AttachmentRepository,
    private readonly objects: AttachmentObjectStore,
  ) {}

  async initiate(
    projectId: string,
    taskId: string,
    actorUserId: string,
    input: AttachmentInitiateInput,
    uploadBasePath: string,
  ): Promise<AttachmentUploadSession> {
    const fileName = normalizeFileName(input.fileName);
    const contentType = normalizeContentType(input.contentType);
    if (
      !Number.isSafeInteger(input.fileSize) ||
      input.fileSize < 1 ||
      input.fileSize > ATTACHMENT_MAX_SIZE
    ) {
      throw new AttachmentError(attachmentErrorCodes.sizeInvalid);
    }

    const fileId = crypto.randomUUID();
    const file = await this.repository.createPending({
      fileId,
      projectId,
      taskId,
      uploadedBy: actorUserId,
      fileName,
      contentType,
      declaredSize: input.fileSize,
      storageKey: (organizationId) =>
        [
          "organizations",
          objectKeySegment(organizationId),
          "projects",
          objectKeySegment(projectId),
          "tasks",
          objectKeySegment(taskId),
          "attachments",
          fileId,
          fileKeySegment(fileName),
        ].join("/"),
      bucket: ATTACHMENT_BUCKET,
    });

    const uploadUrl = `${uploadBasePath}/${file.id}`;
    if (file.declaredSize < ATTACHMENT_MULTIPART_THRESHOLD) {
      return { fileId: file.id, isMultipart: false, uploadUrl };
    }

    let uploadId: string;
    try {
      uploadId = await this.objects.createMultipart(file);
      await this.repository.setMultipartUploadId(projectId, taskId, file.id, actorUserId, uploadId);
    } catch (error) {
      await this.repository.markFailed(projectId, taskId, file.id).catch(() => undefined);
      throw error;
    }

    const partCount = Math.ceil(file.declaredSize / ATTACHMENT_PART_SIZE);
    return {
      fileId: file.id,
      isMultipart: true,
      multipart: {
        uploadId,
        parts: Array.from({ length: partCount }, (_, index) => ({
          partNumber: index + 1,
          uploadUrl: `${uploadUrl}/parts/${index + 1}`,
        })),
      },
    };
  }

  async upload(
    projectId: string,
    taskId: string,
    fileId: string,
    actorUserId: string,
    contentLength: number | null,
    body: ReadableStream | null,
  ): Promise<{ etag: string }> {
    const file = await this.repository.findUpload(projectId, taskId, fileId, actorUserId);
    if (file.multipartUploadId) {
      throw new AttachmentError(attachmentErrorCodes.multipartInvalid);
    }
    this.requireUploadBody(file.declaredSize, contentLength, body);
    return this.objects.put(file, body as ReadableStream);
  }

  async uploadPart(
    projectId: string,
    taskId: string,
    fileId: string,
    partNumber: number,
    actorUserId: string,
    contentLength: number | null,
    body: ReadableStream | null,
  ): Promise<{ etag: string }> {
    const file = await this.repository.findUpload(projectId, taskId, fileId, actorUserId);
    if (!file.multipartUploadId) {
      throw new AttachmentError(attachmentErrorCodes.multipartInvalid);
    }
    this.requireUploadBody(expectedPartSize(file.declaredSize, partNumber), contentLength, body);
    return this.objects.putPart(file, partNumber, body as ReadableStream);
  }

  async complete(
    projectId: string,
    taskId: string,
    fileId: string,
    actorUserId: string,
    uploadId: string | null,
    parts: AttachmentCompletedPart[],
  ): Promise<TaskAttachment> {
    const file = await this.repository.findUpload(projectId, taskId, fileId, actorUserId);
    let inspection: AttachmentObjectInspection | null = null;
    if (file.multipartUploadId) {
      if (uploadId !== file.multipartUploadId) {
        throw new AttachmentError(attachmentErrorCodes.multipartInvalid);
      }
      const expectedCount = Math.ceil(file.declaredSize / ATTACHMENT_PART_SIZE);
      const normalizedParts = [...parts].sort((left, right) => left.partNumber - right.partNumber);
      if (
        normalizedParts.length !== expectedCount ||
        normalizedParts.some(
          (part, index) =>
            part.partNumber !== index + 1 || !part.etag.trim() || part.etag.length > 256,
        )
      ) {
        throw new AttachmentError(attachmentErrorCodes.multipartInvalid);
      }
      try {
        inspection = await this.objects.inspect(file);
      } catch (error) {
        if (
          !(error instanceof AttachmentError) ||
          error.code !== attachmentErrorCodes.objectMissing
        ) {
          throw error;
        }
        await this.objects.completeMultipart(file, normalizedParts);
      }
    } else if (uploadId || parts.length > 0) {
      throw new AttachmentError(attachmentErrorCodes.multipartInvalid);
    }

    if (!inspection) {
      try {
        inspection = await this.objects.inspect(file);
      } catch (error) {
        if (error instanceof AttachmentError) throw error;
        throw new AttachmentError(attachmentErrorCodes.objectMissing);
      }
    }
    if (inspection.size !== file.declaredSize) {
      await Promise.allSettled([
        this.objects.delete(file),
        this.repository.markFailed(projectId, taskId, file.id),
      ]);
      throw new AttachmentError(attachmentErrorCodes.uploadSizeMismatch);
    }
    return this.repository.complete({
      projectId,
      taskId,
      fileId,
      actorUserId,
      inspection,
    });
  }

  async cancel(
    projectId: string,
    taskId: string,
    fileId: string,
    actorUserId: string,
  ): Promise<void> {
    const file = await this.repository.findUpload(projectId, taskId, fileId, actorUserId);
    await this.objects.abort(file);
    await this.repository.markFailed(projectId, taskId, file.id);
  }

  list(projectId: string, taskId: string, deleted = false): Promise<TaskAttachment[]> {
    return this.repository.list(projectId, taskId, deleted);
  }

  get(projectId: string, taskId: string, attachmentId: string): Promise<TaskAttachment> {
    return this.repository.findAttachment(projectId, taskId, attachmentId);
  }

  async content(
    projectId: string,
    taskId: string,
    attachmentId: string,
    rangeHeader?: string,
  ): Promise<{ attachment: TaskAttachment; object: AttachmentObject }> {
    const attachment = await this.repository.findAttachment(projectId, taskId, attachmentId);
    const size = attachment.file.actualSize ?? attachment.file.declaredSize;
    const range = parseAttachmentRange(rangeHeader, size);
    return { attachment, object: await this.objects.get(attachment.file, range) };
  }

  delete(
    projectId: string,
    taskId: string,
    attachmentId: string,
    actorUserId: string,
  ): Promise<void> {
    return this.repository.softDelete(projectId, taskId, attachmentId, actorUserId);
  }

  async restore(
    projectId: string,
    taskId: string,
    attachmentId: string,
    actorUserId: string,
    now = new Date(),
  ): Promise<TaskAttachment> {
    const attachment = await this.repository.findDeletedAttachment(projectId, taskId, attachmentId);
    if (!(await this.objects.exists(attachment.file))) {
      throw new AttachmentError(attachmentErrorCodes.objectMissing);
    }
    return this.repository.restore(projectId, taskId, attachmentId, actorUserId, now);
  }

  private requireUploadBody(
    expectedLength: number,
    contentLength: number | null,
    body: ReadableStream | null,
  ): asserts body is ReadableStream {
    if (!body || contentLength !== expectedLength) {
      throw new AttachmentError(attachmentErrorCodes.uploadSizeMismatch);
    }
  }
}
