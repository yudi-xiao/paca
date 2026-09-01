/// <reference types="@cloudflare/vitest-plugin/types" />

import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as encoding from "lib0/encoding";
import { describe, expect, it } from "vitest";
import * as syncProtocol from "y-protocols/sync";
import { applyUpdate, encodeStateAsUpdate, Doc as YDoc } from "yjs";

import {
  DOCUMENT_CONTEXT_HEADER,
  type DocumentConnectionState,
  encodeDocumentConnectionState,
} from "../../src/document/realtime-protocol";

const DOCUMENT_ID = "44444444-4444-4444-8444-444444444444";
const MESSAGE_SYNC = 0;

function connectionState(
  overrides: Partial<DocumentConnectionState> = {},
): DocumentConnectionState {
  const now = Date.now();
  return {
    version: 1,
    actorType: "user",
    actorId: "user-1",
    sessionId: "session-1",
    organizationId: "organization-1",
    projectId: "11111111-1111-4111-8111-111111111111",
    documentId: DOCUMENT_ID,
    canWrite: true,
    issuedAt: now,
    expiresAt: now + 60_000,
    nonce: crypto.randomUUID(),
    permissionVersion: "a".repeat(64),
    ...overrides,
  };
}

function framedUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

function arrayBuffer(update: Uint8Array): ArrayBuffer {
  return update.buffer.slice(
    update.byteOffset,
    update.byteOffset + update.byteLength,
  ) as ArrayBuffer;
}

async function connect(state: DocumentConnectionState) {
  const stub = env.DocumentParty.getByName(state.documentId);
  const response = await stub.fetch(
    `https://example.test/ws/parties/document-party/${state.documentId}`,
    {
      headers: {
        Upgrade: "websocket",
        [DOCUMENT_CONTEXT_HEADER]: encodeDocumentConnectionState(state),
      },
    },
  );
  const socket = response.webSocket;
  if (!socket) throw new Error("WEBSOCKET_RESPONSE_MISSING");
  socket.accept();
  return { socket, stub };
}

async function waitForUpdates(
  stub: DurableObjectStub<Env["DocumentParty"] extends DurableObjectNamespace<infer T> ? T : never>,
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await stub.persistenceStats()).updateCount >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("DOCUMENT_UPDATE_PERSISTENCE_TIMEOUT");
}

function nextClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WEBSOCKET_CLOSE_TIMEOUT")), 5_000);
    socket.addEventListener(
      "close",
      (event) => {
        clearTimeout(timeout);
        resolve(event);
      },
      { once: true },
    );
  });
}

describe("DocumentParty Durable Object runtime", () => {
  it("persists a user Yjs update before hibernation and restores the exact state", async () => {
    const { socket, stub } = await connect(connectionState());
    const source = new YDoc();
    source.getText("content").insert(0, "Paca collaboration");

    socket.send(framedUpdate(encodeStateAsUpdate(source)));
    await waitForUpdates(stub, 1);
    expect(await stub.persistenceStats()).toMatchObject({ revision: 1 });
    await expect(stub.materializationSnapshot(1)).resolves.toMatchObject({
      documentId: DOCUMENT_ID,
      revision: 1,
    });
    await stub.acknowledgeMaterialization(1);
    expect(await stub.persistenceStats()).toMatchObject({ acknowledgedRevision: 1 });
    await evictDurableObject(stub, { webSockets: "hibernate" });

    const restored = new YDoc();
    applyUpdate(restored, new Uint8Array(await stub.snapshot()));
    expect(restored.getText("content").toString()).toBe("Paca collaboration");
    socket.close(1000, "done");
  });

  it("rejects raw Agent/user read-only Yjs updates", async () => {
    const documentId = "55555555-5555-4555-8555-555555555555";
    const { socket, stub } = await connect(
      connectionState({
        actorType: "agent",
        actorId: "agent-1",
        sessionId: null,
        canWrite: false,
        documentId,
      }),
    );
    const source = new YDoc();
    source.getText("content").insert(0, "must not persist");

    socket.send(framedUpdate(encodeStateAsUpdate(source)));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await stub.persistenceStats()).toMatchObject({ initialized: false, updateCount: 0 });
    socket.close(1000, "done");
  });

  it("compacts updates into a checkpoint that survives eviction", async () => {
    const documentId = "66666666-6666-4666-8666-666666666666";
    const { socket, stub } = await connect(connectionState({ documentId }));
    const source = new YDoc();
    source.getMap("document").set("title", "M8 checkpoint");
    socket.send(framedUpdate(encodeStateAsUpdate(source)));
    await waitForUpdates(stub, 1);

    expect(await stub.compact()).toMatchObject({ initialized: true, updateCount: 0 });
    await evictDurableObject(stub, { webSockets: "hibernate" });

    const restored = new YDoc();
    applyUpdate(restored, new Uint8Array(await stub.snapshot()));
    expect(restored.getMap("document").get("title")).toBe("M8 checkpoint");
    socket.close(1000, "done");
  });

  it("atomically bootstraps an empty document and keeps the first writer's state", async () => {
    const documentId = "88888888-8888-4888-8888-888888888888";
    const stub = env.DocumentParty.getByName(documentId);
    const first = new YDoc();
    first.getText("content").insert(0, "first writer");
    const second = new YDoc();
    second.getText("content").insert(0, "second writer");

    await expect(
      stub.initializeIfEmpty(arrayBuffer(encodeStateAsUpdate(first))),
    ).resolves.toMatchObject({
      initialized: true,
    });
    expect(await stub.persistenceStats()).toMatchObject({ revision: 1 });
    await expect(
      stub.initializeIfEmpty(arrayBuffer(encodeStateAsUpdate(second))),
    ).resolves.toMatchObject({
      initialized: false,
    });
    await evictDurableObject(stub);

    const restored = new YDoc();
    applyUpdate(restored, new Uint8Array(await stub.snapshot()));
    expect(restored.getText("content").toString()).toBe("first writer");
  });

  it("rejects malformed bootstrap updates without initializing persistence", async () => {
    const documentId = "99999999-9999-4999-8999-999999999999";
    const stub = env.DocumentParty.getByName(documentId);

    await expect(stub.initializeIfEmpty(new Uint8Array([255]).buffer)).resolves.toMatchObject({
      initialized: false,
      invalid: true,
    });
    expect(await stub.persistenceStats()).toMatchObject({ initialized: false, updateCount: 0 });
  });

  it("persists session invalidation across hibernation and rejects a stale reconnect", async () => {
    const documentId = "77777777-7777-4777-8777-777777777777";
    const issuedAt = Date.now();
    const state = connectionState({ documentId, issuedAt, expiresAt: issuedAt + 60_000 });
    const { socket, stub } = await connect(state);
    await evictDurableObject(stub, { webSockets: "hibernate" });

    const closed = nextClose(socket);
    expect(await stub.invalidateSession("session-1")).toBe(1);
    await expect(closed).resolves.toMatchObject({ code: 4003 });

    const stale = await connect({ ...state, nonce: crypto.randomUUID() });
    const staleClosed = nextClose(stale.socket);
    await expect(staleClosed).resolves.toMatchObject({ code: 4003 });
  });
});
