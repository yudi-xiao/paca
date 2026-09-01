/// <reference types="@cloudflare/vitest-plugin/types" />

import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as decoding from "lib0/decoding";
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
  socket.binaryType = "arraybuffer";
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

type AgentLeaseStatusMessage = {
  active: boolean;
  expiresAt: number | null;
  serverTime: number;
  type: "document.agent-lease";
};

function nextAgentLeaseStatus(socket: WebSocket): Promise<AgentLeaseStatusMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("AGENT_LEASE_STATUS_TIMEOUT")), 5_000);
    const handleMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string" || !event.data.startsWith("__YPS:")) return;
      const parsed = JSON.parse(event.data.slice(6)) as { type?: string };
      if (parsed.type !== "document.agent-lease") return;
      clearTimeout(timeout);
      socket.removeEventListener("message", handleMessage);
      resolve(parsed as AgentLeaseStatusMessage);
    };
    socket.addEventListener("message", handleMessage);
  });
}

function syncDocumentFromSocket(
  socket: WebSocket,
  accepted: (document: YDoc) => boolean,
): Promise<YDoc> {
  const document = new YDoc();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", handleMessage);
      document.destroy();
      reject(new Error("DOCUMENT_RECONNECT_SYNC_TIMEOUT"));
    }, 5_000);
    const handleMessage = (event: MessageEvent) => {
      const bytes =
        event.data instanceof ArrayBuffer
          ? new Uint8Array(event.data)
          : ArrayBuffer.isView(event.data)
            ? new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength)
            : null;
      if (!bytes) return;
      const decoder = decoding.createDecoder(bytes);
      if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, document, socket);
      if (encoding.length(encoder) > 1) socket.send(encoding.toUint8Array(encoder));
      if (!accepted(document)) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", handleMessage);
      resolve(document);
    };
    socket.addEventListener("message", handleMessage);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, document);
    socket.send(encoding.toUint8Array(encoder));
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

  it("resynchronizes the authoritative Yjs state after a disconnect and hibernation", async () => {
    const documentId = "44444444-4444-4444-8444-444444444445";
    const first = await connect(connectionState({ documentId }));
    const source = new YDoc();
    source.getText("content").insert(0, "persisted before reconnect");
    first.socket.send(framedUpdate(encodeStateAsUpdate(source)));
    await waitForUpdates(first.stub, 1);

    const closed = nextClose(first.socket);
    first.socket.close(1000, "simulate network disconnect");
    await closed;
    await evictDurableObject(first.stub);

    const second = await connect(connectionState({ documentId, nonce: crypto.randomUUID() }));
    const restored = await syncDocumentFromSocket(
      second.socket,
      (document) => document.getText("content").toString() === "persisted before reconnect",
    );
    expect(restored.getText("content").toString()).toBe("persisted before reconnect");
    restored.destroy();
    second.socket.close(1000, "done");
  }, 15_000);

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
      action: "apply" as const,
      requestId: "aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
      runId: "aaaaaaa3-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
      baseRevision: before.revision,
      baseStateVector: before.stateVector,
      operationMode: "suggest" as const,
      operations: [operation],
    };

    await expect(
      stub.executeAsAgent("agent-1", suggestion, Date.now() + 60_000),
    ).resolves.toMatchObject({
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
    const applied = await stub.executeAsAgent("agent-1", edit, Date.now() + 60_000);
    expect(applied).toMatchObject({ applied: true, conflict: false, revision: 2 });
    await expect(stub.executeAsAgent("agent-1", edit, Date.now() + 60_000)).resolves.toEqual(
      applied,
    );
    const changedReplay = await runInDurableObject(stub, async (instance) => {
      try {
        await instance.executeAsAgent(
          "agent-1",
          {
            ...edit,
            operations: [
              {
                ...edit.operations[0],
                content: [{ type: "text" as const, text: "Changed replay", styles: {} }],
              },
            ],
          },
          Date.now() + 60_000,
        );
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
        action: "apply",
        inputFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        operations: [{ type: "replace_block_content", blockId: "block-a" }],
      },
      {
        action: "apply",
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
      action: "apply" as const,
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
    await expect(
      stub.executeAsAgent("agent-1", olderButDisjoint, Date.now() + 60_000),
    ).resolves.toMatchObject({
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
      stub.executeAsAgent(
        "agent-1",
        {
          ...olderButDisjoint,
          requestId: "bbbbbbb4-bbbb-4bbb-8bbb-bbbbbbbbbbb4",
          operations: [
            {
              ...olderButDisjoint.operations[0],
              content: [{ type: "text" as const, text: "Stale overwrite", styles: {} }],
            },
          ],
        },
        Date.now() + 60_000,
      ),
    ).resolves.toMatchObject({ applied: false, conflict: true, revision: 3 });
    connection.socket.close(1000, "done");
  });

  it("coordinates acquire, renew, exclusive apply, release, and user write blocking", async () => {
    const documentId = "ccccccc1-cccc-4ccc-8ccc-ccccccccccc1";
    const stub = env.DocumentParty.getByName(documentId);
    await stub.initializeIfEmpty(arrayBuffer(encodeStateAsUpdate(blockNoteDocument())));
    const before = await stub.readForAgent();
    const userConnection = await connect(connectionState({ documentId }));
    await expect(nextAgentLeaseStatus(userConnection.socket)).resolves.toEqual({
      type: "document.agent-lease",
      active: false,
      expiresAt: null,
      serverTime: expect.any(Number),
    });
    const userDocument = new YDoc();
    applyUpdate(userDocument, new Uint8Array(await stub.snapshot()));
    const userBaseVector = encodeStateVector(userDocument);
    replaceParagraphText(userDocument, "block-b", "User update after lease");
    const userUpdate = encodeStateAsUpdate(userDocument, userBaseVector);
    const runId = "ccccccc2-cccc-4ccc-8ccc-ccccccccccc2";
    const authorizationExpiresAt = Date.now() + 120_000;
    const acquire = {
      action: "acquire_lease" as const,
      requestId: "ccccccc3-cccc-4ccc-8ccc-ccccccccccc3",
      runId,
      operationMode: "exclusive" as const,
      leaseDurationMs: 5_000,
    };

    const acquiredStatus = nextAgentLeaseStatus(userConnection.socket);
    const acquired = await stub.executeAsAgent("agent-1", acquire, authorizationExpiresAt);
    expect(acquired).toMatchObject({
      action: "acquire_lease",
      acquired: true,
      conflict: false,
      revision: 1,
    });
    if (acquired.action !== "acquire_lease" || !acquired.leaseId) {
      throw new Error("LEASE_ID_MISSING");
    }
    await expect(acquiredStatus).resolves.toMatchObject({
      type: "document.agent-lease",
      active: true,
      expiresAt: acquired.expiresAt,
      serverTime: expect.any(Number),
    });
    await expect(stub.executeAsAgent("agent-1", acquire, authorizationExpiresAt)).resolves.toEqual(
      acquired,
    );
    await expect(
      stub.executeAsAgent(
        "agent-2",
        {
          ...acquire,
          requestId: "ccccccc4-cccc-4ccc-8ccc-ccccccccccc4",
          runId: "ccccccc5-cccc-4ccc-8ccc-ccccccccccc5",
        },
        authorizationExpiresAt,
      ),
    ).resolves.toMatchObject({ acquired: false, conflict: true, leaseId: null });

    userConnection.socket.send(framedUpdate(userUpdate));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await stub.persistenceStats()).toMatchObject({ revision: 1, updateCount: 1 });

    const exclusiveEdit = {
      action: "apply" as const,
      requestId: "ccccccc6-cccc-4ccc-8ccc-ccccccccccc6",
      runId,
      baseRevision: before.revision,
      baseStateVector: before.stateVector,
      operationMode: "exclusive" as const,
      leaseId: acquired.leaseId,
      operations: [
        {
          type: "replace_block_content" as const,
          blockId: "block-a",
          expectedBlockVersion: before.blocks[0]?.version ?? "missing",
          content: [{ type: "text" as const, text: "Exclusive Agent update", styles: {} }],
        },
      ],
    };
    await expect(
      stub.executeAsAgent("agent-1", exclusiveEdit, authorizationExpiresAt),
    ).resolves.toMatchObject({
      action: "apply",
      applied: true,
      mode: "exclusive",
      revision: 2,
    });

    const blockedCollaborator = await runInDurableObject(stub, async (instance) => {
      try {
        const current = await instance.readForAgent();
        await instance.executeAsAgent(
          "agent-2",
          {
            action: "apply",
            requestId: "ccccccc7-cccc-4ccc-8ccc-ccccccccccc7",
            runId: "ccccccc8-cccc-4ccc-8ccc-ccccccccccc8",
            baseRevision: current.revision,
            baseStateVector: current.stateVector,
            operationMode: "collaborate",
            operations: [
              {
                type: "replace_block_content",
                blockId: "block-b",
                expectedBlockVersion: current.blocks[1]?.version ?? "missing",
                content: [{ type: "text", text: "must be blocked", styles: {} }],
              },
            ],
          },
          authorizationExpiresAt,
        );
        return "unexpected-success";
      } catch (error) {
        return error instanceof Error ? error.message : "unknown-error";
      }
    });
    expect(blockedCollaborator).toBe("DOCUMENT_AGENT_LEASE_HELD");

    const renewedStatus = nextAgentLeaseStatus(userConnection.socket);
    const renewed = await stub.executeAsAgent(
      "agent-1",
      {
        action: "renew_lease",
        requestId: "ccccccc9-cccc-4ccc-8ccc-ccccccccccc9",
        runId,
        operationMode: "exclusive",
        leaseId: acquired.leaseId,
        leaseDurationMs: 60_000,
      },
      authorizationExpiresAt,
    );
    expect(renewed).toMatchObject({ action: "renew_lease", acquired: true });
    if (renewed.action !== "renew_lease") throw new Error("LEASE_RENEWAL_RESULT_INVALID");
    expect(renewed.expiresAt ?? 0).toBeGreaterThan(acquired.expiresAt ?? 0);
    await expect(renewedStatus).resolves.toMatchObject({
      type: "document.agent-lease",
      active: true,
      expiresAt: renewed.expiresAt,
      serverTime: expect.any(Number),
    });

    const releasedStatus = nextAgentLeaseStatus(userConnection.socket);
    await expect(
      stub.executeAsAgent(
        "agent-1",
        {
          action: "release_lease",
          requestId: "ccccccca-cccc-4ccc-8ccc-ccccccccccca",
          runId,
          operationMode: "exclusive",
          leaseId: acquired.leaseId,
        },
        authorizationExpiresAt,
      ),
    ).resolves.toMatchObject({ action: "release_lease", released: true });
    await expect(releasedStatus).resolves.toEqual({
      type: "document.agent-lease",
      active: false,
      expiresAt: null,
      serverTime: expect.any(Number),
    });

    userConnection.socket.send(framedUpdate(userUpdate));
    await waitForUpdates(stub, 3);
    expect(
      (await stub.readForAgent()).blocks.map((entry) => JSON.parse(entry.blockJson).content),
    ).toEqual([
      [{ type: "text", text: "Exclusive Agent update", styles: {} }],
      [{ type: "text", text: "User update after lease", styles: {} }],
    ]);
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ count: number }>("SELECT count(*) AS count FROM paca_document_agent_lease")
          .one().count,
      ).toBe(0);
    });
    userConnection.socket.close(1000, "done");
  });

  it("allows expired lease takeover and clears an Agent lease on revocation", async () => {
    const documentId = "ddddddd1-dddd-4ddd-8ddd-ddddddddddd1";
    const stub = env.DocumentParty.getByName(documentId);
    await stub.initializeIfEmpty(arrayBuffer(encodeStateAsUpdate(blockNoteDocument())));
    const authorizationExpiresAt = Date.now() + 120_000;
    const first = await stub.executeAsAgent(
      "agent-1",
      {
        action: "acquire_lease",
        requestId: "ddddddd2-dddd-4ddd-8ddd-ddddddddddd2",
        runId: "ddddddd3-dddd-4ddd-8ddd-ddddddddddd3",
        operationMode: "exclusive",
        leaseDurationMs: 5_000,
      },
      authorizationExpiresAt,
    );
    expect(first).toMatchObject({ acquired: true });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE paca_document_agent_lease SET expires_at = ? WHERE singleton = 1",
        Date.now() - 1,
      );
    });

    await expect(
      stub.executeAsAgent(
        "agent-2",
        {
          action: "acquire_lease",
          requestId: "ddddddd4-dddd-4ddd-8ddd-ddddddddddd4",
          runId: "ddddddd5-dddd-4ddd-8ddd-ddddddddddd5",
          operationMode: "exclusive",
          leaseDurationMs: 5_000,
        },
        authorizationExpiresAt,
      ),
    ).resolves.toMatchObject({ acquired: true, conflict: false });
    expect(await stub.invalidateActor("agent", "agent-2")).toBe(0);
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ count: number }>("SELECT count(*) AS count FROM paca_document_agent_lease")
          .one().count,
      ).toBe(0);
    });
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
