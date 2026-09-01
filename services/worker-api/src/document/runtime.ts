import type { AppBindings } from "../bindings";
import { withDatabase } from "../database";
import { PostgresDocumentRepository } from "./postgres-repository";
import {
  type DocumentCreateInput,
  DocumentError,
  DocumentService,
  type DocumentUpdateInput,
  documentErrorCodes,
  type PacaDocument,
} from "./service";

export type DocumentCollaborationStatus = {
  initialized: boolean;
  updateCount: number;
  updateBytes: number;
  checkpointBytes: number;
};

export type DocumentRuntime = {
  list(env: AppBindings, projectId: string): Promise<PacaDocument[]>;
  get(env: AppBindings, projectId: string, documentId: string): Promise<PacaDocument>;
  create(
    env: AppBindings,
    projectId: string,
    actorUserId: string,
    input: DocumentCreateInput,
  ): Promise<PacaDocument>;
  update(
    env: AppBindings,
    projectId: string,
    documentId: string,
    actorUserId: string,
    input: DocumentUpdateInput,
  ): Promise<PacaDocument>;
  archive(
    env: AppBindings,
    projectId: string,
    documentId: string,
    actorUserId: string,
  ): Promise<void>;
  collaborationStatus(env: AppBindings, documentId: string): Promise<DocumentCollaborationStatus>;
  bootstrapCollaboration(
    env: AppBindings,
    documentId: string,
    update: ArrayBuffer,
  ): Promise<{ initialized: boolean }>;
  invalidateCollaboration(env: AppBindings, documentId: string): Promise<number>;
};

function withService<T>(
  env: AppBindings,
  operation: (service: DocumentService) => Promise<T>,
): Promise<T> {
  return withDatabase(env, (database) =>
    operation(new DocumentService(new PostgresDocumentRepository(database))),
  );
}

export const documentRuntime: DocumentRuntime = {
  list: (env, projectId) => withService(env, (service) => service.list(projectId)),
  get: (env, projectId, documentId) =>
    withService(env, (service) => service.get(projectId, documentId)),
  create: (env, projectId, actorUserId, input) =>
    withService(env, (service) => service.create(projectId, actorUserId, input)),
  update: (env, projectId, documentId, actorUserId, input) =>
    withService(env, (service) => service.update(projectId, documentId, actorUserId, input)),
  archive: async (env, projectId, documentId, actorUserId) => {
    await withService(env, (service) => service.archive(projectId, documentId, actorUserId));
    await env.DocumentParty.getByName(documentId).invalidateAll();
  },
  collaborationStatus: async (env, documentId) => {
    const stats = await env.DocumentParty.getByName(documentId).persistenceStats();
    return {
      initialized: stats.initialized,
      updateCount: stats.updateCount,
      updateBytes: stats.updateBytes,
      checkpointBytes: stats.checkpointBytes,
    };
  },
  bootstrapCollaboration: async (env, documentId, update) => {
    const result = await env.DocumentParty.getByName(documentId).initializeIfEmpty(update);
    if (result.invalid) throw new DocumentError(documentErrorCodes.contentInvalid);
    return { initialized: result.initialized };
  },
  invalidateCollaboration: (env, documentId) =>
    env.DocumentParty.getByName(documentId).invalidateAll(),
};
