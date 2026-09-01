/// <reference types="@cloudflare/vitest-plugin/types" />

import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as encoding from "lib0/encoding";
import { describe, expect, it } from "vitest";
import * as syncProtocol from "y-protocols/sync";
import {
  applyUpdate,
  encodeStateAsUpdate,
  encodeStateVector,
  Doc as YDoc,
  XmlElement as YXmlElement,
  XmlText as YXmlText,
} from "yjs";

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

function paragraph(id: string, value: string): YXmlElement {
  const container = new YXmlElement("blockContainer");
  container.setAttribute("id", id);
  const content = new YXmlElement("paragraph");
  const text = new YXmlText();
  text.insert(0, value);
  content.insert(0, [text]);
  container.insert(0, [content]);
  return container;
}

function blockNoteDocument(): YDoc {
  const document = new YDoc();
  const group = new YXmlElement("blockGroup");
  group.insert(0, [paragraph("block-a", "Alpha"), paragraph("block-b", "Beta")]);
  document.getXmlFragment("document-store").insert(0, [group]);
  return document;
}

function replaceParagraphText(document: YDoc, blockId: string, value: string): void {
  const group = document.getXmlFragment("document-store").get(0);
  if (!(group instanceof YXmlElement)) throw new Error("BLOCK_GROUP_MISSING");
  const container = group
    .toArray()
    .find(
      (candidate): candidate is YXmlElement =>
        candidate instanceof YXmlElement && candidate.getAttribute("id") === blockId,
    );
  const content = container?.get(0);
  if (!(content instanceof YXmlElement)) throw new Error("BLOCK_CONTENT_MISSING");
  document.transact(() => {
    if (content.length > 0) content.delete(0, content.length);
    const text = new YXmlText();
    text.insert(0, value);
    content.insert(0, [text]);
  });
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

  it("keeps suggestions non-mutating and applies an idempotent structured Agent edit", async () => {
    const documentId = "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    const stub = env.DocumentParty.getByName(documentId);
    await stub.initializeIfEmpty(arrayBuffer(encodeStateAsUpdate(blockNoteDocument())));
    const before = await stub.readForAgent();
    const operation = {
      type: "replace_block_content" as const,
      blockId: "block-a",
      expectedBlockVersion: before.blocks[0]?.version ?? "missing",
      content: [{ type: "text" as const, text: "Agent result", styles: { bold: true } }],
    };
    const suggestion = {
      requestId: "aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
      runId: "aaaaaaa3-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
      baseRevision: before.revision,
      baseStateVector: before.stateVector,
      operationMode: "suggest" as const,
      operations: [operation],
    };

    await expect(stub.editAsAgent("agent-1", suggestion)).resolves.toMatchObject({
      applied: false,
      conflict: false,
      mode: "suggest",
      revision: before.revision,
    });
    expect(
      JSON.parse((await stub.readForAgent()).blocks[0]?.blockJson ?? "null").content,
    ).toMatchObject([{ type: "text", text: "Alpha" }]);

    const edit = {
      ...suggestion,
      requestId: "aaaaaaa4-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
      operationMode: "collaborate" as const,
    };
    const applied = await stub.editAsAgent("agent-1", edit);
    expect(applied).toMatchObject({ applied: true, conflict: false, revision: 2 });
    await expect(stub.editAsAgent("agent-1", edit)).resolves.toEqual(applied);
    const changedReplay = await runInDurableObject(stub, async (instance) => {
      try {
        await instance.editAsAgent("agent-1", {
          ...edit,
          operations: [
            {
              ...edit.operations[0],
              content: [{ type: "text" as const, text: "Changed replay", styles: {} }],
            },
          ],
        });
        return "unexpected-success";
      } catch (error) {
        return error instanceof Error ? error.message : "unknown-error";
      }
    });
    expect(changedReplay).toBe("DOCUMENT_AGENT_REQUEST_ID_REUSED");
    expect(await stub.persistenceStats()).toMatchObject({ revision: 2, updateCount: 2 });
    expect(JSON.parse((await stub.readForAgent()).blocks[0]?.blockJson ?? "null").content).toEqual([
      { type: "text", text: "Agent result", styles: { bold: true } },
    ]);

    const audit = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{
          agentId: string;
          operationSummary: string;
          requestId: string;
          runId: string;
          status: string;
        }>(
          `SELECT request_id AS requestId, run_id AS runId, agent_id AS agentId,
                  status, operation_summary AS operationSummary
             FROM paca_document_agent_operation_audit
            ORDER BY created_at ASC`,
        )
        .toArray(),
    );
    expect(audit).toEqual([
      {
        requestId: suggestion.requestId,
        runId: suggestion.runId,
        agentId: "agent-1",
        status: "suggested",
        operationSummary: expect.stringContaining('"operations"'),
      },
      {
        requestId: edit.requestId,
        runId: edit.runId,
        agentId: "agent-1",
        status: "applied",
        operationSummary: expect.stringContaining('"operations"'),
      },
    ]);
    expect(JSON.stringify(audit)).not.toContain("Agent result");
    expect(audit.map((entry) => JSON.parse(entry.operationSummary))).toEqual([
      {
        inputFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        operations: [{ type: "replace_block_content", blockId: "block-a" }],
      },
      {
        inputFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        operations: [{ type: "replace_block_content", blockId: "block-a" }],
      },
    ]);
  });

  it("conflicts on a changed target but accepts an older snapshot for an unchanged block", async () => {
    const documentId = "bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
    const stub = env.DocumentParty.getByName(documentId);
    await stub.initializeIfEmpty(arrayBuffer(encodeStateAsUpdate(blockNoteDocument())));
    const before = await stub.readForAgent();
    const baseDocument = new YDoc();
    applyUpdate(baseDocument, new Uint8Array(await stub.snapshot()));
    const userDocument = new YDoc();
    applyUpdate(userDocument, encodeStateAsUpdate(baseDocument));
    replaceParagraphText(userDocument, "block-b", "User changed Beta");
    const userUpdate = encodeStateAsUpdate(userDocument, encodeStateVector(baseDocument));
    const connection = await connect(connectionState({ documentId }));
    connection.socket.send(framedUpdate(userUpdate));
    await waitForUpdates(stub, 2);

    const olderButDisjoint = {
      requestId: "bbbbbbb2-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
      runId: "bbbbbbb3-bbbb-4bbb-8bbb-bbbbbbbbbbb3",
      baseRevision: before.revision,
      baseStateVector: before.stateVector,
      operationMode: "collaborate" as const,
      operations: [
        {
          type: "replace_block_content" as const,
          blockId: "block-a",
          expectedBlockVersion: before.blocks[0]?.version ?? "missing",
          content: [{ type: "text" as const, text: "Agent changed Alpha", styles: {} }],
        },
      ],
    };
    await expect(stub.editAsAgent("agent-1", olderButDisjoint)).resolves.toMatchObject({
      applied: true,
      conflict: false,
      baseRevision: 1,
      revision: 3,
    });

    const current = await stub.readForAgent();
    expect(current.blocks.map((entry) => JSON.parse(entry.blockJson).content)).toEqual([
      [{ type: "text", text: "Agent changed Alpha", styles: {} }],
      [{ type: "text", text: "User changed Beta", styles: {} }],
    ]);
    await expect(
      stub.editAsAgent("agent-1", {
        ...olderButDisjoint,
        requestId: "bbbbbbb4-bbbb-4bbb-8bbb-bbbbbbbbbbb4",
        operations: [
          {
            ...olderButDisjoint.operations[0],
            content: [{ type: "text" as const, text: "Stale overwrite", styles: {} }],
          },
        ],
      }),
    ).resolves.toMatchObject({ applied: false, conflict: true, revision: 3 });
    connection.socket.close(1000, "done");
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
