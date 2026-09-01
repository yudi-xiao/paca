import { describe, expect, it, vi } from "vitest";

import type { AppBindings } from "../src/bindings";
import {
  consumeDocumentMaterializationQueue,
  type DocumentProjectionRepository,
  type DocumentSnapshotStore,
  R2DocumentSnapshotStore,
} from "../src/document/materialization";

const documentId = "44444444-4444-4444-8444-444444444444";
const snapshot = new Uint8Array([1, 2, 3]).buffer;

function queueMessage(body: unknown, attempts = 1) {
  return {
    id: "queue-message-1",
    timestamp: new Date(),
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function batch(message: ReturnType<typeof queueMessage>): MessageBatch<unknown> {
  return {
    queue: "paca-document-materialization-test",
    messages: [message],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<unknown>;
}

function event(revision = 4) {
  return {
    kind: "document.materialize",
    version: 1,
    documentId,
    revision,
    createdAt: "2026-09-01T00:00:00.000Z",
  };
}

function dependencies(result: Awaited<ReturnType<DocumentProjectionRepository["materialize"]>>) {
  const acknowledgeMaterialization = vi.fn(async () => undefined);
  const materializationSnapshot = vi.fn(async () => ({ documentId, revision: 5, snapshot }));
  const materialize = vi.fn(() => [{ type: "paragraph", content: [] }]);
  const repository: DocumentProjectionRepository = { materialize: vi.fn(async () => result) };
  const snapshots: DocumentSnapshotStore = {
    put: vi.fn(async () => ({
      key: `documents/${documentId}/yjs/5.bin`,
      sha256: "a".repeat(64),
      bytes: 3,
      created: true,
    })),
    delete: vi.fn(async () => undefined),
  };
  return {
    dependencies: {
      documents: {
        getByName: vi.fn(() => ({ acknowledgeMaterialization, materializationSnapshot })),
      },
      materialize,
      repository,
      snapshots,
      now: () => new Date("2026-09-01T01:00:00.000Z"),
    },
    acknowledgeMaterialization,
    materializationSnapshot,
    materialize,
    repository,
    snapshots,
  };
}

describe("document materialization queue", () => {
  it("coalesces to the current DO revision, stores it, and advances the projection", async () => {
    const message = queueMessage(event());
    const context = dependencies({ status: "applied", currentRevision: 5 });

    await consumeDocumentMaterializationQueue(
      batch(message),
      {} as AppBindings,
      context.dependencies,
    );

    expect(context.materializationSnapshot).toHaveBeenCalledWith(4);
    expect(context.repository.materialize).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId,
        revision: 5,
        snapshotKey: `documents/${documentId}/yjs/5.bin`,
        snapshotBytes: 3,
      }),
    );
    expect(context.acknowledgeMaterialization).toHaveBeenCalledWith(5);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("deletes a newly-created orphan snapshot when a newer projection already won", async () => {
    const message = queueMessage(event());
    const context = dependencies({ status: "stale", currentRevision: 8 });

    await consumeDocumentMaterializationQueue(
      batch(message),
      {} as AppBindings,
      context.dependencies,
    );

    expect(context.snapshots.delete).toHaveBeenCalledWith(`documents/${documentId}/yjs/5.bin`);
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it("acknowledges poison messages without touching storage", async () => {
    const message = queueMessage({ kind: "document.materialize" });
    const context = dependencies({ status: "applied", currentRevision: 5 });

    await consumeDocumentMaterializationQueue(
      batch(message),
      {} as AppBindings,
      context.dependencies,
    );

    expect(message.ack).toHaveBeenCalledOnce();
    expect(context.snapshots.put).not.toHaveBeenCalled();
  });

  it("retries transient failures with bounded backoff", async () => {
    const message = queueMessage(event(), 3);
    const context = dependencies({ status: "applied", currentRevision: 5 });
    context.materializationSnapshot.mockRejectedValueOnce(new Error("DOCUMENT_DO_UNAVAILABLE"));

    await consumeDocumentMaterializationQueue(
      batch(message),
      {} as AppBindings,
      context.dependencies,
    );

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 20 });
    expect(message.ack).not.toHaveBeenCalled();
  });
});

describe("R2 document snapshot store", () => {
  it("uses an immutable revision key and verifies an idempotent duplicate", async () => {
    const digest = await crypto.subtle.digest("SHA-256", snapshot);
    const sha256 = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const put = vi.fn(async () => null);
    const head = vi.fn(async () => ({
      size: 3,
      customMetadata: { sha256 },
    }));
    const store = new R2DocumentSnapshotStore({ put, head } as unknown as R2Bucket);

    await expect(store.put(documentId, 5, snapshot)).resolves.toEqual({
      key: `documents/${documentId}/yjs/5.bin`,
      sha256,
      bytes: 3,
      created: false,
    });
    expect(put).toHaveBeenCalledWith(
      `documents/${documentId}/yjs/5.bin`,
      snapshot,
      expect.objectContaining({
        onlyIf: { etagDoesNotMatch: "*" },
        customMetadata: expect.objectContaining({ revision: "5", sha256, bytes: "3" }),
      }),
    );
    expect(head).toHaveBeenCalledWith(`documents/${documentId}/yjs/5.bin`);
  });

  it("rejects a conflicting object at the same revision key", async () => {
    const store = new R2DocumentSnapshotStore({
      put: vi.fn(async () => null),
      head: vi.fn(async () => ({ size: 3, customMetadata: { sha256: "b".repeat(64) } })),
    } as unknown as R2Bucket);

    await expect(store.put(documentId, 5, snapshot)).rejects.toThrow(
      "DOCUMENT_SNAPSHOT_IMMUTABILITY_VIOLATION",
    );
  });
});
