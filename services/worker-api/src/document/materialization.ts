import { and, eq, isNull, lt, sql } from "drizzle-orm";

import type { AppBindings } from "../bindings";
import type { PacaDatabase } from "../database";
import { withDatabase } from "../database";
import { pacaDocuments } from "../db/schema";
import { materializeBlockNoteSnapshot } from "./blocknote-materializer";
import {
  type DocumentMaterializationMessage,
  parseDocumentMaterializationMessage,
} from "./materialization-protocol";

type MaterializationSnapshot = {
  documentId: string;
  revision: number;
  snapshot: ArrayBuffer;
};

type DocumentPartyStub = {
  acknowledgeMaterialization(revision: number): Promise<void>;
  materializationSnapshot(minimumRevision: number): Promise<MaterializationSnapshot>;
};

type DocumentPartyNamespace = {
  getByName(name: string): DocumentPartyStub;
};

export type DocumentProjectionInput = {
  documentId: string;
  revision: number;
  content: unknown[];
  snapshotKey: string;
  snapshotSha256: string;
  snapshotBytes: number;
  snapshotAt: Date;
};

export type DocumentProjectionResult = {
  status: "applied" | "missing" | "stale";
  currentRevision: number | null;
};

export interface DocumentProjectionRepository {
  materialize(input: DocumentProjectionInput): Promise<DocumentProjectionResult>;
}

export type StoredDocumentSnapshot = {
  key: string;
  sha256: string;
  bytes: number;
  created: boolean;
};

export interface DocumentSnapshotStore {
  put(documentId: string, revision: number, snapshot: ArrayBuffer): Promise<StoredDocumentSnapshot>;
  delete(key: string): Promise<void>;
}

function bytesToHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class R2DocumentSnapshotStore implements DocumentSnapshotStore {
  constructor(private readonly bucket: R2Bucket) {}

  async put(
    documentId: string,
    revision: number,
    snapshot: ArrayBuffer,
  ): Promise<StoredDocumentSnapshot> {
    const key = `documents/${documentId}/yjs/${revision}.bin`;
    const digest = await crypto.subtle.digest("SHA-256", snapshot);
    const sha256 = bytesToHex(digest);
    const metadata = {
      documentId,
      revision: String(revision),
      sha256,
      bytes: String(snapshot.byteLength),
    };
    const object = await this.bucket.put(key, snapshot, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/vnd.yjs-update" },
      customMetadata: metadata,
      sha256: digest,
    });
    if (object) return { key, sha256, bytes: snapshot.byteLength, created: true };

    const existing = await this.bucket.head(key);
    if (
      !existing ||
      existing.size !== snapshot.byteLength ||
      existing.customMetadata?.sha256 !== sha256
    ) {
      throw new Error("DOCUMENT_SNAPSHOT_IMMUTABILITY_VIOLATION");
    }
    return { key, sha256, bytes: snapshot.byteLength, created: false };
  }

  delete(key: string): Promise<void> {
    return this.bucket.delete(key);
  }
}

export class PostgresDocumentProjectionRepository implements DocumentProjectionRepository {
  constructor(private readonly database: PacaDatabase) {}

  async materialize(input: DocumentProjectionInput): Promise<DocumentProjectionResult> {
    const [updated] = await this.database
      .update(pacaDocuments)
      .set({
        content: input.content,
        contentVersion: sql`${pacaDocuments.contentVersion} + 1`,
        yjsRevision: input.revision,
        yjsSnapshotKey: input.snapshotKey,
        yjsSnapshotSha256: input.snapshotSha256,
        yjsSnapshotBytes: input.snapshotBytes,
        yjsSnapshotAt: input.snapshotAt,
        updatedAt: input.snapshotAt,
      })
      .where(
        and(
          eq(pacaDocuments.id, input.documentId),
          isNull(pacaDocuments.deletedAt),
          lt(pacaDocuments.yjsRevision, input.revision),
        ),
      )
      .returning({ revision: pacaDocuments.yjsRevision });
    if (updated) return { status: "applied", currentRevision: updated.revision };

    const [existing] = await this.database
      .select({ revision: pacaDocuments.yjsRevision })
      .from(pacaDocuments)
      .where(and(eq(pacaDocuments.id, input.documentId), isNull(pacaDocuments.deletedAt)))
      .limit(1);
    return existing
      ? { status: "stale", currentRevision: existing.revision }
      : { status: "missing", currentRevision: null };
  }
}

export type DocumentMaterializationConsumerDependencies = {
  documents?: DocumentPartyNamespace;
  materialize?: typeof materializeBlockNoteSnapshot;
  now?: () => Date;
  repository?: DocumentProjectionRepository;
  snapshots?: DocumentSnapshotStore;
};

function retryDelay(attempts: number): number {
  return Math.min(300, 5 * 2 ** Math.min(Math.max(attempts - 1, 0), 6));
}

function errorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message)) return error.message;
  return "DOCUMENT_MATERIALIZATION_FAILED";
}

async function consumeWithDependencies(
  batch: MessageBatch<unknown>,
  env: AppBindings,
  repository: DocumentProjectionRepository,
  snapshots: DocumentSnapshotStore,
  dependencies: DocumentMaterializationConsumerDependencies,
): Promise<void> {
  for (const queueMessage of batch.messages) {
    let event: DocumentMaterializationMessage;
    try {
      event = parseDocumentMaterializationMessage(queueMessage.body);
    } catch {
      console.error(
        JSON.stringify({
          event: "document.materialization.invalid_message",
          queueMessageId: queueMessage.id,
        }),
      );
      queueMessage.ack();
      continue;
    }

    let stored: StoredDocumentSnapshot | undefined;
    try {
      const stub = (dependencies.documents ?? env.DocumentParty).getByName(event.documentId);
      const current = await stub.materializationSnapshot(event.revision);
      if (
        current.documentId !== event.documentId ||
        !Number.isSafeInteger(current.revision) ||
        current.revision < event.revision ||
        !(current.snapshot instanceof ArrayBuffer)
      ) {
        throw new Error("DOCUMENT_MATERIALIZATION_SNAPSHOT_INVALID");
      }
      const content = (dependencies.materialize ?? materializeBlockNoteSnapshot)(current.snapshot);
      stored = await snapshots.put(current.documentId, current.revision, current.snapshot);
      const result = await repository.materialize({
        documentId: current.documentId,
        revision: current.revision,
        content,
        snapshotKey: stored.key,
        snapshotSha256: stored.sha256,
        snapshotBytes: stored.bytes,
        snapshotAt: (dependencies.now ?? (() => new Date()))(),
      });
      if (
        stored.created &&
        (result.status === "missing" ||
          (result.status === "stale" && (result.currentRevision ?? 0) > current.revision))
      ) {
        await snapshots.delete(stored.key);
      }
      await stub.acknowledgeMaterialization(current.revision);
      queueMessage.ack();
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "document.materialization.failed",
          documentId: event.documentId,
          revision: event.revision,
          errorCode: errorCode(error),
          attempts: queueMessage.attempts,
        }),
      );
      queueMessage.retry({ delaySeconds: retryDelay(queueMessage.attempts) });
    }
  }
}

export async function consumeDocumentMaterializationQueue(
  batch: MessageBatch<unknown>,
  env: AppBindings,
  dependencies: DocumentMaterializationConsumerDependencies = {},
): Promise<void> {
  const snapshots = dependencies.snapshots ?? new R2DocumentSnapshotStore(env.DOCUMENT_SNAPSHOTS);
  if (dependencies.repository) {
    return consumeWithDependencies(batch, env, dependencies.repository, snapshots, dependencies);
  }
  return withDatabase(env, (database) =>
    consumeWithDependencies(
      batch,
      env,
      new PostgresDocumentProjectionRepository(database),
      snapshots,
      dependencies,
    ),
  );
}
