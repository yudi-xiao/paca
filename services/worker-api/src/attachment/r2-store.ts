import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import type { AppBindings } from "../bindings";
import {
  type AttachmentCompletedPart,
  AttachmentError,
  type AttachmentFile,
  type AttachmentObject,
  type AttachmentObjectInspection,
  type AttachmentObjectStore,
  attachmentErrorCodes,
} from "./service";

export class R2AttachmentObjectStore implements AttachmentObjectStore {
  constructor(private readonly env: AppBindings) {}

  async createMultipart(file: AttachmentFile): Promise<string> {
    const upload = await this.env.TASK_ATTACHMENTS.createMultipartUpload(file.storageKey, {
      httpMetadata: { contentType: file.contentType },
      customMetadata: this.customMetadata(file),
    });
    return upload.uploadId;
  }

  async put(file: AttachmentFile, body: ReadableStream): Promise<{ etag: string }> {
    const object = await this.env.TASK_ATTACHMENTS.put(file.storageKey, body, {
      onlyIf: new Headers({ "if-none-match": "*" }),
      httpMetadata: { contentType: file.contentType },
      customMetadata: this.customMetadata(file),
    });
    if (!object) throw new AttachmentError(attachmentErrorCodes.uploadNotPending);
    return { etag: object.httpEtag };
  }

  async putPart(
    file: AttachmentFile,
    partNumber: number,
    body: ReadableStream,
  ): Promise<{ etag: string }> {
    if (!file.multipartUploadId) {
      throw new AttachmentError(attachmentErrorCodes.multipartInvalid);
    }
    const upload = this.env.TASK_ATTACHMENTS.resumeMultipartUpload(
      file.storageKey,
      file.multipartUploadId,
    );
    const part = await upload.uploadPart(partNumber, body);
    return { etag: part.etag };
  }

  async completeMultipart(
    file: AttachmentFile,
    parts: AttachmentCompletedPart[],
  ): Promise<{ etag: string }> {
    if (!file.multipartUploadId) {
      throw new AttachmentError(attachmentErrorCodes.multipartInvalid);
    }
    const upload = this.env.TASK_ATTACHMENTS.resumeMultipartUpload(
      file.storageKey,
      file.multipartUploadId,
    );
    const object = await upload.complete(parts);
    return { etag: object.httpEtag };
  }

  async abort(file: AttachmentFile): Promise<void> {
    if (file.multipartUploadId) {
      await this.env.TASK_ATTACHMENTS.resumeMultipartUpload(
        file.storageKey,
        file.multipartUploadId,
      ).abort();
      return;
    }
    await this.env.TASK_ATTACHMENTS.delete(file.storageKey);
  }

  async exists(file: AttachmentFile): Promise<boolean> {
    return (await this.env.TASK_ATTACHMENTS.head(file.storageKey)) !== null;
  }

  async inspect(file: AttachmentFile): Promise<AttachmentObjectInspection> {
    const object = await this.env.TASK_ATTACHMENTS.get(file.storageKey);
    if (!object) throw new AttachmentError(attachmentErrorCodes.objectMissing);

    const hash = createHash("sha256");
    const reader = object.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }

    return {
      size: object.size,
      etag: object.etag,
      sha256: hash.digest("hex"),
    };
  }

  async get(
    file: AttachmentFile,
    range?: { offset: number; length: number },
  ): Promise<AttachmentObject> {
    const object = await this.env.TASK_ATTACHMENTS.get(
      file.storageKey,
      range ? { range } : undefined,
    );
    if (!object) throw new AttachmentError(attachmentErrorCodes.objectMissing);

    const returnedRange = range
      ? {
          offset: range.offset,
          length: Math.min(range.length, Math.max(0, object.size - range.offset)),
        }
      : null;
    return {
      body: object.body,
      etag: object.httpEtag,
      size: object.size,
      range: returnedRange,
    };
  }

  async delete(file: AttachmentFile): Promise<void> {
    await this.env.TASK_ATTACHMENTS.delete(file.storageKey);
  }

  private customMetadata(file: AttachmentFile): Record<string, string> {
    return {
      organizationId: file.organizationId,
      projectId: file.projectId,
      taskId: file.taskId,
      fileId: file.id,
    };
  }
}
