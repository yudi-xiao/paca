import type { Connection, ConnectionContext, WSMessage } from "partyserver";
import { YServer } from "y-partyserver";
import { applyUpdate, encodeStateAsUpdate, Doc as YDoc } from "yjs";

import {
  DOCUMENT_CONTEXT_HEADER,
  type DocumentConnectionState,
  decodeDocumentConnectionState,
} from "./realtime-protocol";

type DocumentConnection = Connection<DocumentConnectionState>;
type InvalidationScope = "actor" | "document" | "session";

type UpdateRow = {
  updateBlob: ArrayBuffer;
};

type DocumentUpdateActor = {
  actorType: "agent" | "system" | "user";
  actorId: string;
};

export type DocumentPersistenceStats = {
  documentId: string;
  initialized: boolean;
  updateCount: number;
  updateBytes: number;
  checkpointBytes: number;
};

const AUTHORIZATION_CLOSE_CODE = 4003;
const AUTHORIZATION_CLOSE_REASON = "document authorization changed";
const MAX_UPDATE_BYTES = 256 * 1024;
const CHECKPOINT_UPDATE_COUNT = 128;
const CHECKPOINT_UPDATE_BYTES = 1024 * 1024;

function cloneArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function actorFromOrigin(origin: unknown): DocumentUpdateActor {
  if (!origin || typeof origin !== "object" || !("state" in origin)) {
    return { actorType: "system", actorId: "system" };
  }
  const state = (origin as { state?: unknown }).state;
  if (!state || typeof state !== "object") return { actorType: "system", actorId: "system" };
  const { actorType, actorId } = state as { actorType?: unknown; actorId?: unknown };
  if (
    (actorType === "user" || actorType === "agent") &&
    typeof actorId === "string" &&
    actorId.length > 0 &&
    actorId.length <= 255
  ) {
    return { actorType, actorId };
  }
  return { actorType: "system", actorId: "system" };
}

export class DocumentParty extends YServer {
  static override options = { hibernate: true };
  static override callbackOptions = {
    debounceWait: 2_000,
    debounceMaxWait: 10_000,
    timeout: 5_000,
  };

  private readonly durableState: DurableObjectState;
  private loading = true;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.durableState = state;
    state.blockConcurrencyWhile(async () => {
      state.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS paca_document_sql_migration (
          version INTEGER PRIMARY KEY,
          applied_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS paca_document_meta (
          document_id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS paca_document_yjs_checkpoint (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          update_blob BLOB NOT NULL,
          byte_size INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS paca_document_yjs_update (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          update_blob BLOB NOT NULL,
          byte_size INTEGER NOT NULL,
          actor_type TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS paca_document_yjs_update_created_idx
          ON paca_document_yjs_update (created_at, sequence);
        CREATE TABLE IF NOT EXISTS paca_document_invalidation (
          scope TEXT NOT NULL,
          subject TEXT NOT NULL,
          invalidated_at INTEGER NOT NULL,
          PRIMARY KEY (scope, subject)
        );
        INSERT OR IGNORE INTO paca_document_sql_migration (version, applied_at)
        VALUES (1, unixepoch('subsec') * 1000);
      `);
    });
  }

  override async onStart(): Promise<void> {
    this.loading = true;
    this.document.on("update", (update: Uint8Array, origin: unknown) => {
      if (this.loading) return;
      this.persistUpdate(update, origin);
    });
    await super.onStart();
    this.loading = false;
  }

  override async onLoad(): Promise<YDoc | undefined> {
    this.ensureDocumentIdentity();
    const restored = new YDoc();
    let hasState = false;
    const [checkpoint] = this.durableState.storage.sql
      .exec<UpdateRow>(
        `SELECT update_blob AS updateBlob
           FROM paca_document_yjs_checkpoint
          WHERE singleton = 1`,
      )
      .toArray();
    if (checkpoint) {
      applyUpdate(restored, new Uint8Array(checkpoint.updateBlob));
      hasState = true;
    }
    for (const row of this.durableState.storage.sql
      .exec<UpdateRow>(
        `SELECT update_blob AS updateBlob
           FROM paca_document_yjs_update
          ORDER BY sequence ASC`,
      )
      .toArray()) {
      applyUpdate(restored, new Uint8Array(row.updateBlob));
      hasState = true;
    }
    return hasState ? restored : undefined;
  }

  override async onSave(): Promise<void> {
    const stats = this.persistenceStats();
    if (
      stats.updateCount >= CHECKPOINT_UPDATE_COUNT ||
      stats.updateBytes >= CHECKPOINT_UPDATE_BYTES
    ) {
      await this.compact();
    }
  }

  override getConnectionTags(_connection: Connection, context: ConnectionContext): string[] {
    const state = decodeDocumentConnectionState(
      context.request.headers.get(DOCUMENT_CONTEXT_HEADER),
    );
    if (!state) return ["unauthenticated"];
    return [
      `actor:${state.actorType}:${state.actorId}`,
      `document:${state.documentId}`,
      `permission:${state.permissionVersion}`,
    ];
  }

  override async onConnect(
    connection: DocumentConnection,
    context: ConnectionContext,
  ): Promise<void> {
    const state = decodeDocumentConnectionState(
      context.request.headers.get(DOCUMENT_CONTEXT_HEADER),
    );
    if (
      !state ||
      state.documentId !== this.name ||
      state.issuedAt > Date.now() ||
      state.expiresAt <= Date.now() ||
      this.isInvalidated(state)
    ) {
      connection.close(AUTHORIZATION_CLOSE_CODE, "document authorization invalid");
      return;
    }
    connection.setState(state);
    await super.onConnect(connection, context);
  }

  override onMessage(connection: DocumentConnection, message: WSMessage): void {
    const state = connection.state;
    if (!state || state.expiresAt <= Date.now() || this.isInvalidated(state)) {
      connection.close(AUTHORIZATION_CLOSE_CODE, AUTHORIZATION_CLOSE_REASON);
      return;
    }
    const messageBytes =
      typeof message === "string"
        ? new TextEncoder().encode(message).byteLength
        : message instanceof ArrayBuffer
          ? message.byteLength
          : message.byteLength;
    if (messageBytes > MAX_UPDATE_BYTES + 16) {
      connection.close(1009, "document message too large");
      return;
    }
    super.onMessage(connection, message);
  }

  override isReadOnly(connection: DocumentConnection): boolean {
    const state = connection.state;
    return !state?.canWrite || state.expiresAt <= Date.now() || this.isInvalidated(state);
  }

  async initializeIfEmpty(update: ArrayBuffer): Promise<{
    initialized: boolean;
    invalid?: boolean;
    snapshot: ArrayBuffer;
  }> {
    await this.setName(this.name);
    if (update.byteLength === 0 || update.byteLength > MAX_UPDATE_BYTES) {
      return {
        initialized: false,
        invalid: true,
        snapshot: cloneArrayBuffer(encodeStateAsUpdate(this.document)),
      };
    }
    const probe = new YDoc();
    try {
      applyUpdate(probe, new Uint8Array(update));
    } catch {
      return {
        initialized: false,
        invalid: true,
        snapshot: cloneArrayBuffer(encodeStateAsUpdate(this.document)),
      };
    } finally {
      probe.destroy();
    }
    const stats = this.persistenceStats();
    if (stats.initialized) {
      return { initialized: false, snapshot: cloneArrayBuffer(encodeStateAsUpdate(this.document)) };
    }
    applyUpdate(this.document, new Uint8Array(update), "bootstrap");
    return { initialized: true, snapshot: cloneArrayBuffer(encodeStateAsUpdate(this.document)) };
  }

  async snapshot(): Promise<ArrayBuffer> {
    await this.setName(this.name);
    return cloneArrayBuffer(encodeStateAsUpdate(this.document));
  }

  async compact(): Promise<DocumentPersistenceStats> {
    await this.setName(this.name);
    const snapshot = encodeStateAsUpdate(this.document);
    const now = Date.now();
    this.durableState.storage.sql.exec(
      `INSERT INTO paca_document_yjs_checkpoint (singleton, update_blob, byte_size, created_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT (singleton) DO UPDATE SET
         update_blob = excluded.update_blob,
         byte_size = excluded.byte_size,
         created_at = excluded.created_at`,
      cloneArrayBuffer(snapshot),
      snapshot.byteLength,
      now,
    );
    this.durableState.storage.sql.exec("DELETE FROM paca_document_yjs_update");
    return this.persistenceStats();
  }

  persistenceStats(): DocumentPersistenceStats {
    const [updates] = this.durableState.storage.sql
      .exec<{ updateCount: number; updateBytes: number }>(
        `SELECT count(*) AS updateCount, coalesce(sum(byte_size), 0) AS updateBytes
           FROM paca_document_yjs_update`,
      )
      .toArray();
    const [checkpoint] = this.durableState.storage.sql
      .exec<{ checkpointBytes: number }>(
        `SELECT byte_size AS checkpointBytes
           FROM paca_document_yjs_checkpoint
          WHERE singleton = 1`,
      )
      .toArray();
    const updateCount = updates?.updateCount ?? 0;
    const updateBytes = updates?.updateBytes ?? 0;
    const checkpointBytes = checkpoint?.checkpointBytes ?? 0;
    return {
      documentId: this.name,
      initialized: updateCount > 0 || checkpointBytes > 0,
      updateCount,
      updateBytes,
      checkpointBytes,
    };
  }

  invalidateActor(actorType: "user" | "agent", actorId: string): number {
    if (!actorId || actorId.length > 255) throw new Error("DOCUMENT_ACTOR_INVALID");
    const subject = `${actorType}:${actorId}`;
    this.setInvalidation("actor", subject);
    return this.closeConnections(
      (state) => state.actorType === actorType && state.actorId === actorId,
    );
  }

  invalidateSession(sessionId: string): number {
    if (!sessionId || sessionId.length > 255) throw new Error("DOCUMENT_SESSION_INVALID");
    this.setInvalidation("session", sessionId);
    return this.closeConnections((state) => state.sessionId === sessionId);
  }

  invalidateAll(): number {
    this.setInvalidation("document", this.name);
    return this.closeConnections(() => true);
  }

  override onRequest(): Response {
    return Response.json(
      { status: "error", code: "DOCUMENT_WEBSOCKET_REQUIRED" },
      { status: 426, headers: { "cache-control": "no-store" } },
    );
  }

  override onException(error: unknown): void {
    console.error(
      JSON.stringify({
        event: "document.party.exception",
        documentId: this.name,
        errorName: error instanceof Error ? error.name : "UnknownError",
      }),
    );
  }

  private ensureDocumentIdentity(): void {
    const [identity] = this.durableState.storage.sql
      .exec<{ documentId: string }>(
        "SELECT document_id AS documentId FROM paca_document_meta LIMIT 1",
      )
      .toArray();
    if (identity && identity.documentId !== this.name) {
      throw new Error("DOCUMENT_PARTY_IDENTITY_MISMATCH");
    }
    if (!identity) {
      this.durableState.storage.sql.exec(
        "INSERT INTO paca_document_meta (document_id, created_at) VALUES (?, ?)",
        this.name,
        Date.now(),
      );
    }
  }

  private persistUpdate(update: Uint8Array, origin: unknown): void {
    if (update.byteLength === 0 || update.byteLength > MAX_UPDATE_BYTES) {
      throw new Error("DOCUMENT_UPDATE_TOO_LARGE");
    }
    const actor = actorFromOrigin(origin);
    this.durableState.storage.sql.exec(
      `INSERT INTO paca_document_yjs_update
         (update_blob, byte_size, actor_type, actor_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      cloneArrayBuffer(update),
      update.byteLength,
      actor.actorType,
      actor.actorId,
      Date.now(),
    );
  }

  private closeConnections(predicate: (state: DocumentConnectionState) => boolean): number {
    let closed = 0;
    for (const connection of this.getConnections<DocumentConnectionState>()) {
      const state = connection.state;
      if (!state || !predicate(state)) continue;
      connection.close(AUTHORIZATION_CLOSE_CODE, AUTHORIZATION_CLOSE_REASON);
      closed += 1;
    }
    return closed;
  }

  private isInvalidated(state: DocumentConnectionState): boolean {
    const subjects: Array<[InvalidationScope, string]> = [
      ["document", state.documentId],
      ["actor", `${state.actorType}:${state.actorId}`],
    ];
    if (state.sessionId) subjects.push(["session", state.sessionId]);
    for (const [scope, subject] of subjects) {
      const [row] = this.durableState.storage.sql
        .exec<{ invalidatedAt: number }>(
          `SELECT invalidated_at AS invalidatedAt
             FROM paca_document_invalidation
            WHERE scope = ? AND subject = ?`,
          scope,
          subject,
        )
        .toArray();
      if (row && row.invalidatedAt >= state.issuedAt) return true;
    }
    return false;
  }

  private setInvalidation(scope: InvalidationScope, subject: string): void {
    this.durableState.storage.sql.exec(
      `INSERT INTO paca_document_invalidation (scope, subject, invalidated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (scope, subject) DO UPDATE SET
         invalidated_at = max(invalidated_at, excluded.invalidated_at)`,
      scope,
      subject,
      Date.now(),
    );
  }
}
