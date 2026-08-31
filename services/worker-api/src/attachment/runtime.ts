import type { AppBindings } from "../bindings";
import { R2AttachmentObjectStore } from "./r2-store";
import { RuntimeAttachmentRepository } from "./runtime-repository";
import {
  type AttachmentCompletedPart,
  type AttachmentInitiateInput,
  type AttachmentObject,
  AttachmentService,
  type AttachmentUploadSession,
  type TaskAttachment,
} from "./service";

export type AttachmentRuntime = {
  initiate(
    env: AppBindings,
    projectId: string,
    taskId: string,
    actorUserId: string,
    input: AttachmentInitiateInput,
    uploadBasePath: string,
  ): Promise<AttachmentUploadSession>;
  upload(
    env: AppBindings,
    projectId: string,
    taskId: string,
    fileId: string,
    actorUserId: string,
    contentLength: number | null,
    body: ReadableStream | null,
  ): Promise<{ etag: string }>;
  uploadPart(
    env: AppBindings,
    projectId: string,
    taskId: string,
    fileId: string,
    partNumber: number,
    actorUserId: string,
    contentLength: number | null,
    body: ReadableStream | null,
  ): Promise<{ etag: string }>;
  complete(
    env: AppBindings,
    projectId: string,
    taskId: string,
    fileId: string,
    actorUserId: string,
    uploadId: string | null,
    parts: AttachmentCompletedPart[],
  ): Promise<TaskAttachment>;
  cancel(
    env: AppBindings,
    projectId: string,
    taskId: string,
    fileId: string,
    actorUserId: string,
  ): Promise<void>;
  list(
    env: AppBindings,
    projectId: string,
    taskId: string,
    deleted?: boolean,
  ): Promise<TaskAttachment[]>;
  get(
    env: AppBindings,
    projectId: string,
    taskId: string,
    attachmentId: string,
  ): Promise<TaskAttachment>;
  content(
    env: AppBindings,
    projectId: string,
    taskId: string,
    attachmentId: string,
    rangeHeader?: string,
  ): Promise<{ attachment: TaskAttachment; object: AttachmentObject }>;
  delete(
    env: AppBindings,
    projectId: string,
    taskId: string,
    attachmentId: string,
    actorUserId: string,
  ): Promise<void>;
  restore(
    env: AppBindings,
    projectId: string,
    taskId: string,
    attachmentId: string,
    actorUserId: string,
  ): Promise<TaskAttachment>;
};

function service(env: AppBindings): AttachmentService {
  return new AttachmentService(
    new RuntimeAttachmentRepository(env),
    new R2AttachmentObjectStore(env),
  );
}

export const attachmentRuntime: AttachmentRuntime = {
  initiate: (env, projectId, taskId, actorUserId, input, uploadBasePath) =>
    service(env).initiate(projectId, taskId, actorUserId, input, uploadBasePath),
  upload: (env, projectId, taskId, fileId, actorUserId, contentLength, body) =>
    service(env).upload(projectId, taskId, fileId, actorUserId, contentLength, body),
  uploadPart: (env, projectId, taskId, fileId, partNumber, actorUserId, contentLength, body) =>
    service(env).uploadPart(
      projectId,
      taskId,
      fileId,
      partNumber,
      actorUserId,
      contentLength,
      body,
    ),
  complete: (env, projectId, taskId, fileId, actorUserId, uploadId, parts) =>
    service(env).complete(projectId, taskId, fileId, actorUserId, uploadId, parts),
  cancel: (env, projectId, taskId, fileId, actorUserId) =>
    service(env).cancel(projectId, taskId, fileId, actorUserId),
  list: (env, projectId, taskId, deleted) => service(env).list(projectId, taskId, deleted),
  get: (env, projectId, taskId, attachmentId) => service(env).get(projectId, taskId, attachmentId),
  content: (env, projectId, taskId, attachmentId, rangeHeader) =>
    service(env).content(projectId, taskId, attachmentId, rangeHeader),
  delete: (env, projectId, taskId, attachmentId, actorUserId) =>
    service(env).delete(projectId, taskId, attachmentId, actorUserId),
  restore: (env, projectId, taskId, attachmentId, actorUserId) =>
    service(env).restore(projectId, taskId, attachmentId, actorUserId),
};
