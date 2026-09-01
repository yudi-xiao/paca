import type { Connection, ConnectionContext, WSMessage } from "partyserver";
import { YServer } from "y-partyserver";
import { applyUpdate, encodeStateAsUpdate, Doc as YDoc } from "yjs";

import {
  applyDocumentAgentOperations,
  type DocumentAgentCommand,
  type DocumentAgentCommandResult,
  type DocumentAgentEditResult,
  type DocumentAgentLeaseResult,
  type DocumentAgentSnapshot,
  documentAgentCommandSchema,
  evaluateDocumentAgentEdit,
  inspectDocumentForAgent,
} from "./agent-operations";
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

type AgentOperationAudit = {
  actorId: string;
  inputFingerprint: string;
  input: DocumentAgentCommand;
  result: DocumentAgentCommandResult;
  status:
    | "applied"
    | "conflict"
    | "lease_acquired"
    | "lease_conflict"
    | "lease_released"
    | "lease_renewed"
    | "suggested"
    | "unchanged";
};

type AgentLeaseRow = {
  acquiredAt: number;
  agentId: string;
  expiresAt: number;
  leaseId: string;
  renewedAt: number;
  runId: string;
};

type AgentOperationOrigin = {
  marker: symbol;
  state: { actorType: "agent"; actorId: string };
  audit?: AgentOperationAudit;
};

export type DocumentPersistenceStats = {
  documentId: string;
  initialized: boolean;
  updateCount: number;
  updateBytes: number;
  checkpointBytes: number;
  revision: number;
  queuedRevision: number;
  acknowledgedRevision: number;
};

export type DocumentMaterializationSnapshot = {
  documentId: string;
  revision: number;
  snapshot: ArrayBuffer;
};

const AUTHORIZATION_CLOSE_CODE = 4003;
const AUTHORIZATION_CLOSE_REASON = "document authorization changed";
const MAX_UPDATE_BYTES = 256 * 1024;
const CHECKPOINT_UPDATE_COUNT = 128;
const CHECKPOINT_UPDATE_BYTES = 1024 * 1024;
const AGENT_OPERATION_ORIGIN = Symbol("paca.document.agent-operation");
const AGENT_LEASE_MESSAGE_TYPE = "document.agent-lease";

function cloneArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

async function agentOperationFingerprint(input: DocumentAgentCommand): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(input)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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

function agentAuditFromOrigin(origin: unknown): AgentOperationAudit | null {
  if (!origin || typeof origin !== "object") return null;
  const candidate = origin as Partial<AgentOperationOrigin>;
  return candidate.marker === AGENT_OPERATION_ORIGIN && candidate.audit ? candidate.audit : null;
}

export class DocumentParty extends YServer {
  static override options = { hibernate: true };
  static override callbackOptions = {
    debounceWait: 2_000,
    debounceMaxWait: 10_000,
    timeout: 5_000,
  };

  private readonly durableState: DurableObjectState;
  private readonly environment: Env;
  private loading = true;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.durableState = state;
    this.environment = env;
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
        CREATE TABLE IF NOT EXISTS paca_document_materialization_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          revision INTEGER NOT NULL CHECK (revision >= 0),
          queued_revision INTEGER NOT NULL CHECK (queued_revision >= 0),
          acknowledged_revision INTEGER NOT NULL CHECK (acknowledged_revision >= 0),
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS paca_document_agent_operation_audit (
          request_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          operation_mode TEXT NOT NULL,
          base_revision INTEGER NOT NULL,
          result_revision INTEGER NOT NULL,
          status TEXT NOT NULL,
          operation_summary TEXT NOT NULL,
          result_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS paca_document_agent_operation_run_idx
          ON paca_document_agent_operation_audit (run_id, created_at);
        CREATE TABLE IF NOT EXISTS paca_document_agent_lease (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          lease_id TEXT NOT NULL UNIQUE,
          agent_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          acquired_at INTEGER NOT NULL,
          renewed_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO paca_document_materialization_state
          (singleton, revision, queued_revision, acknowledged_revision, updated_at)
        SELECT 1,
          CASE WHEN
            EXISTS (SELECT 1 FROM paca_document_yjs_checkpoint WHERE singleton = 1) OR
            EXISTS (SELECT 1 FROM paca_document_yjs_update LIMIT 1)
          THEN 1 ELSE 0 END,
          0,
          0,
          unixepoch('subsec') * 1000;
        INSERT OR IGNORE INTO paca_document_sql_migration (version, applied_at)
        VALUES (1, unixepoch('subsec') * 1000);
        INSERT OR IGNORE INTO paca_document_sql_migration (version, applied_at)
        VALUES (2, unixepoch('subsec') * 1000);
        INSERT OR IGNORE INTO paca_document_sql_migration (version, applied_at)
        VALUES (3, unixepoch('subsec') * 1000);
        INSERT OR IGNORE INTO paca_document_sql_migration (version, applied_at)
        VALUES (4, unixepoch('subsec') * 1000);
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
    await this.enqueueMaterialization();
  }

  override async onAlarm(): Promise<void> {
    await this.enqueueMaterialization();
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
    this.sendAgentLeaseStatus(connection);
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
    return (
      !state?.canWrite ||
      state.expiresAt <= Date.now() ||
      this.isInvalidated(state) ||
      Boolean(this.activeAgentLease())
    );
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
    await this.enqueueMaterialization();
    return { initialized: true, snapshot: cloneArrayBuffer(encodeStateAsUpdate(this.document)) };
  }

  async snapshot(): Promise<ArrayBuffer> {
    await this.setName(this.name);
    return cloneArrayBuffer(encodeStateAsUpdate(this.document));
  }

  async readForAgent(): Promise<DocumentAgentSnapshot> {
    await this.setName(this.name);
    const stats = this.persistenceStats();
    if (!stats.initialized || stats.revision <= 0) {
      throw new Error("DOCUMENT_AGENT_NOT_INITIALIZED");
    }
    return inspectDocumentForAgent(this.document, this.name, stats.revision);
  }

  async executeAsAgent(
    actorId: string,
    value: unknown,
    authorizationExpiresAt: number,
  ): Promise<DocumentAgentCommandResult> {
    await this.setName(this.name);
    if (!actorId || actorId.length > 255) throw new Error("DOCUMENT_AGENT_ACTOR_INVALID");
    const input = documentAgentCommandSchema.parse(value);
    const inputFingerprint = await agentOperationFingerprint(input);
    const duplicate = this.findAgentOperationResult(input.requestId, actorId, inputFingerprint);
    if (duplicate) return duplicate;

    const stats = this.persistenceStats();
    if (!stats.initialized || stats.revision <= 0) {
      throw new Error("DOCUMENT_AGENT_NOT_INITIALIZED");
    }
    if (input.action === "acquire_lease") {
      return this.acquireAgentLease(
        actorId,
        inputFingerprint,
        input,
        stats.revision,
        authorizationExpiresAt,
      );
    }
    if (input.action === "renew_lease") {
      return this.renewAgentLease(
        actorId,
        inputFingerprint,
        input,
        stats.revision,
        authorizationExpiresAt,
      );
    }
    if (input.action === "release_lease") {
      return this.releaseAgentLease(actorId, inputFingerprint, input, stats.revision);
    }

    const activeLease = this.activeAgentLease();
    if (input.operationMode === "exclusive") {
      if (
        !activeLease ||
        activeLease.agentId !== actorId ||
        activeLease.runId !== input.runId ||
        activeLease.leaseId !== input.leaseId
      ) {
        throw new Error("DOCUMENT_AGENT_EXCLUSIVE_LEASE_INVALID");
      }
    } else if (input.operationMode === "collaborate" && activeLease) {
      throw new Error("DOCUMENT_AGENT_LEASE_HELD");
    }

    const before = inspectDocumentForAgent(this.document, this.name, stats.revision);
    const { conflicts } = evaluateDocumentAgentEdit(before, input);
    if (conflicts.length > 0) {
      const result: DocumentAgentEditResult = {
        action: "apply",
        applied: false,
        conflict: true,
        documentId: this.name,
        requestId: input.requestId,
        runId: input.runId,
        mode: input.operationMode,
        baseRevision: input.baseRevision,
        revision: before.revision,
        stateVector: before.stateVector,
        targets: conflicts.map((conflict) => ({
          blockId: conflict.blockId,
          version: conflict.version ?? "missing",
        })),
      };
      this.recordAgentOperation(actorId, inputFingerprint, input, result, "conflict");
      return result;
    }

    const versions = new Map(before.blocks.map((entry) => [entry.blockId, entry.version]));
    const targets = input.operations.map((operation) => ({
      blockId: operation.blockId,
      version: versions.get(operation.blockId) ?? "missing",
    }));
    if (input.operationMode === "suggest") {
      const result: DocumentAgentEditResult = {
        action: "apply",
        applied: false,
        conflict: false,
        documentId: this.name,
        requestId: input.requestId,
        runId: input.runId,
        mode: "suggest",
        baseRevision: input.baseRevision,
        revision: before.revision,
        stateVector: before.stateVector,
        targets,
      };
      this.recordAgentOperation(actorId, inputFingerprint, input, result, "suggested");
      return result;
    }

    const blocks = new Map(
      before.blocks.map((entry) => [
        entry.blockId,
        JSON.parse(entry.blockJson) as Record<string, unknown>,
      ]),
    );
    const changes = input.operations.some(
      (operation) =>
        JSON.stringify(blocks.get(operation.blockId)?.content ?? []) !==
        JSON.stringify(operation.content),
    );
    if (!changes) {
      const result: DocumentAgentEditResult = {
        action: "apply",
        applied: false,
        conflict: false,
        documentId: this.name,
        requestId: input.requestId,
        runId: input.runId,
        mode: input.operationMode,
        baseRevision: input.baseRevision,
        revision: before.revision,
        stateVector: before.stateVector,
        targets,
      };
      this.recordAgentOperation(actorId, inputFingerprint, input, result, "unchanged");
      return result;
    }

    let result: DocumentAgentEditResult | null = null;
    const origin: AgentOperationOrigin = {
      marker: AGENT_OPERATION_ORIGIN,
      state: { actorType: "agent", actorId },
    };
    this.document.transact(() => {
      applyDocumentAgentOperations(this.document, input.operations);
      const after = inspectDocumentForAgent(this.document, this.name, before.revision + 1);
      const afterVersions = new Map(after.blocks.map((entry) => [entry.blockId, entry.version]));
      result = {
        action: "apply",
        applied: true,
        conflict: false,
        documentId: this.name,
        requestId: input.requestId,
        runId: input.runId,
        mode: input.operationMode,
        baseRevision: input.baseRevision,
        revision: after.revision,
        stateVector: after.stateVector,
        targets: input.operations.map((operation) => ({
          blockId: operation.blockId,
          version: afterVersions.get(operation.blockId) ?? "missing",
        })),
      };
      origin.audit = { actorId, inputFingerprint, input, result, status: "applied" };
    }, origin);
    if (!result) throw new Error("DOCUMENT_AGENT_UPDATE_NOT_APPLIED");
    return result;
  }

  async materializationSnapshot(minimumRevision: number): Promise<DocumentMaterializationSnapshot> {
    await this.setName(this.name);
    if (!Number.isSafeInteger(minimumRevision) || minimumRevision <= 0) {
      throw new Error("DOCUMENT_MATERIALIZATION_REVISION_INVALID");
    }
    const state = this.materializationState();
    if (state.revision < minimumRevision) {
      throw new Error("DOCUMENT_MATERIALIZATION_REVISION_NOT_READY");
    }
    return {
      documentId: this.name,
      revision: state.revision,
      snapshot: cloneArrayBuffer(encodeStateAsUpdate(this.document)),
    };
  }

  async acknowledgeMaterialization(revision: number): Promise<void> {
    if (!Number.isSafeInteger(revision) || revision <= 0) {
      throw new Error("DOCUMENT_MATERIALIZATION_REVISION_INVALID");
    }
    this.durableState.storage.sql.exec(
      `UPDATE paca_document_materialization_state
          SET acknowledged_revision = max(acknowledged_revision, min(revision, ?)),
              updated_at = ?
        WHERE singleton = 1`,
      revision,
      Date.now(),
    );
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
    const materialization = this.materializationState();
    return {
      documentId: this.name,
      initialized: updateCount > 0 || checkpointBytes > 0,
      updateCount,
      updateBytes,
      checkpointBytes,
      ...materialization,
    };
  }

  invalidateActor(actorType: "user" | "agent", actorId: string): number {
    if (!actorId || actorId.length > 255) throw new Error("DOCUMENT_ACTOR_INVALID");
    const subject = `${actorType}:${actorId}`;
    const releasedLease = actorType === "agent" && this.agentLease()?.agentId === actorId;
    this.durableState.storage.transactionSync(() => {
      this.setInvalidation("actor", subject);
      if (actorType === "agent") {
        this.durableState.storage.sql.exec(
          "DELETE FROM paca_document_agent_lease WHERE agent_id = ?",
          actorId,
        );
      }
    });
    if (releasedLease) this.broadcastAgentLeaseStatus();
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
    this.durableState.storage.transactionSync(() => {
      this.setInvalidation("document", this.name);
      this.durableState.storage.sql.exec("DELETE FROM paca_document_agent_lease");
    });
    this.broadcastAgentLeaseStatus();
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

  private acquireAgentLease(
    actorId: string,
    inputFingerprint: string,
    input: Extract<DocumentAgentCommand, { action: "acquire_lease" }>,
    revision: number,
    authorizationExpiresAt: number,
  ): DocumentAgentLeaseResult {
    const now = Date.now();
    const existing = this.activeAgentLease(now);
    if (existing) {
      const result: DocumentAgentLeaseResult = {
        action: "acquire_lease",
        acquired: false,
        conflict: true,
        documentId: this.name,
        expiresAt: existing.expiresAt,
        leaseId: null,
        released: false,
        requestId: input.requestId,
        revision,
        runId: input.runId,
      };
      this.recordAgentOperation(actorId, inputFingerprint, input, result, "lease_conflict");
      return result;
    }

    const expiresAt = this.agentLeaseExpiry(now, input.leaseDurationMs, authorizationExpiresAt);
    const leaseId = crypto.randomUUID();
    const result: DocumentAgentLeaseResult = {
      action: "acquire_lease",
      acquired: true,
      conflict: false,
      documentId: this.name,
      expiresAt,
      leaseId,
      released: false,
      requestId: input.requestId,
      revision,
      runId: input.runId,
    };
    this.durableState.storage.transactionSync(() => {
      this.durableState.storage.sql.exec(
        `INSERT INTO paca_document_agent_lease
           (singleton, lease_id, agent_id, run_id, acquired_at, renewed_at, expires_at)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (singleton) DO UPDATE SET
           lease_id = excluded.lease_id,
           agent_id = excluded.agent_id,
           run_id = excluded.run_id,
           acquired_at = excluded.acquired_at,
           renewed_at = excluded.renewed_at,
           expires_at = excluded.expires_at`,
        leaseId,
        actorId,
        input.runId,
        now,
        now,
        expiresAt,
      );
      this.insertAgentOperationAudit(
        { actorId, inputFingerprint, input, result, status: "lease_acquired" },
        now,
      );
    });
    this.broadcastAgentLeaseStatus();
    return result;
  }

  private renewAgentLease(
    actorId: string,
    inputFingerprint: string,
    input: Extract<DocumentAgentCommand, { action: "renew_lease" }>,
    revision: number,
    authorizationExpiresAt: number,
  ): DocumentAgentLeaseResult {
    const now = Date.now();
    const existing = this.activeAgentLease(now);
    if (
      !existing ||
      existing.agentId !== actorId ||
      existing.runId !== input.runId ||
      existing.leaseId !== input.leaseId
    ) {
      throw new Error("DOCUMENT_AGENT_EXCLUSIVE_LEASE_INVALID");
    }
    const expiresAt = this.agentLeaseExpiry(now, input.leaseDurationMs, authorizationExpiresAt);
    const result: DocumentAgentLeaseResult = {
      action: "renew_lease",
      acquired: true,
      conflict: false,
      documentId: this.name,
      expiresAt,
      leaseId: input.leaseId,
      released: false,
      requestId: input.requestId,
      revision,
      runId: input.runId,
    };
    this.durableState.storage.transactionSync(() => {
      this.durableState.storage.sql.exec(
        `UPDATE paca_document_agent_lease
            SET renewed_at = ?, expires_at = ?
          WHERE singleton = 1 AND lease_id = ? AND agent_id = ? AND run_id = ?`,
        now,
        expiresAt,
        input.leaseId,
        actorId,
        input.runId,
      );
      this.insertAgentOperationAudit(
        { actorId, inputFingerprint, input, result, status: "lease_renewed" },
        now,
      );
    });
    this.broadcastAgentLeaseStatus();
    return result;
  }

  private releaseAgentLease(
    actorId: string,
    inputFingerprint: string,
    input: Extract<DocumentAgentCommand, { action: "release_lease" }>,
    revision: number,
  ): DocumentAgentLeaseResult {
    const existing = this.agentLease();
    if (
      !existing ||
      existing.agentId !== actorId ||
      existing.runId !== input.runId ||
      existing.leaseId !== input.leaseId
    ) {
      throw new Error("DOCUMENT_AGENT_EXCLUSIVE_LEASE_INVALID");
    }
    const now = Date.now();
    const result: DocumentAgentLeaseResult = {
      action: "release_lease",
      acquired: false,
      conflict: false,
      documentId: this.name,
      expiresAt: null,
      leaseId: input.leaseId,
      released: true,
      requestId: input.requestId,
      revision,
      runId: input.runId,
    };
    this.durableState.storage.transactionSync(() => {
      this.durableState.storage.sql.exec(
        "DELETE FROM paca_document_agent_lease WHERE singleton = 1",
      );
      this.insertAgentOperationAudit(
        { actorId, inputFingerprint, input, result, status: "lease_released" },
        now,
      );
    });
    this.broadcastAgentLeaseStatus();
    return result;
  }

  private agentLeaseExpiry(
    now: number,
    durationMs: number,
    authorizationExpiresAt: number,
  ): number {
    if (!Number.isSafeInteger(authorizationExpiresAt) || authorizationExpiresAt <= now) {
      throw new Error("DOCUMENT_AGENT_AUTHORIZATION_EXPIRED");
    }
    const expiresAt = Math.min(now + durationMs, authorizationExpiresAt);
    if (expiresAt - now < 1_000) {
      throw new Error("DOCUMENT_AGENT_AUTHORIZATION_TOO_SHORT");
    }
    return expiresAt;
  }

  private agentLease(): AgentLeaseRow | null {
    const [lease] = this.durableState.storage.sql
      .exec<AgentLeaseRow>(
        `SELECT lease_id AS leaseId, agent_id AS agentId, run_id AS runId,
                acquired_at AS acquiredAt, renewed_at AS renewedAt, expires_at AS expiresAt
           FROM paca_document_agent_lease
          WHERE singleton = 1`,
      )
      .toArray();
    return lease ?? null;
  }

  private activeAgentLease(now = Date.now()): AgentLeaseRow | null {
    const lease = this.agentLease();
    return lease && lease.expiresAt > now ? lease : null;
  }

  private agentLeaseStatusMessage(): string {
    const serverTime = Date.now();
    const lease = this.activeAgentLease(serverTime);
    return JSON.stringify({
      type: AGENT_LEASE_MESSAGE_TYPE,
      active: Boolean(lease),
      expiresAt: lease?.expiresAt ?? null,
      serverTime,
    });
  }

  private sendAgentLeaseStatus(connection: DocumentConnection): void {
    this.sendCustomMessage(connection, this.agentLeaseStatusMessage());
  }

  private broadcastAgentLeaseStatus(): void {
    this.broadcastCustomMessage(this.agentLeaseStatusMessage());
  }

  private persistUpdate(update: Uint8Array, origin: unknown): void {
    if (update.byteLength === 0 || update.byteLength > MAX_UPDATE_BYTES) {
      throw new Error("DOCUMENT_UPDATE_TOO_LARGE");
    }
    const actor = actorFromOrigin(origin);
    const audit = agentAuditFromOrigin(origin);
    const now = Date.now();
    this.durableState.storage.transactionSync(() => {
      this.durableState.storage.sql.exec(
        `INSERT INTO paca_document_yjs_update
           (update_blob, byte_size, actor_type, actor_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        cloneArrayBuffer(update),
        update.byteLength,
        actor.actorType,
        actor.actorId,
        now,
      );
      this.durableState.storage.sql.exec(
        `UPDATE paca_document_materialization_state
            SET revision = revision + 1, updated_at = ?
          WHERE singleton = 1`,
        now,
      );
      if (audit) this.insertAgentOperationAudit(audit, now);
    });
  }

  private findAgentOperationResult(
    requestId: string,
    actorId: string,
    inputFingerprint: string,
  ): DocumentAgentCommandResult | null {
    const [row] = this.durableState.storage.sql
      .exec<{ agentId: string; operationSummary: string; resultJson: string }>(
        `SELECT agent_id AS agentId, operation_summary AS operationSummary,
                result_json AS resultJson
           FROM paca_document_agent_operation_audit
          WHERE request_id = ?`,
        requestId,
      )
      .toArray();
    if (!row) return null;
    const summary = JSON.parse(row.operationSummary) as { inputFingerprint?: unknown };
    if (row.agentId !== actorId || summary.inputFingerprint !== inputFingerprint) {
      throw new Error("DOCUMENT_AGENT_REQUEST_ID_REUSED");
    }
    return JSON.parse(row.resultJson) as DocumentAgentCommandResult;
  }

  private recordAgentOperation(
    actorId: string,
    inputFingerprint: string,
    input: DocumentAgentCommand,
    result: DocumentAgentCommandResult,
    status: AgentOperationAudit["status"],
  ): void {
    this.insertAgentOperationAudit(
      { actorId, inputFingerprint, input, result, status },
      Date.now(),
    );
  }

  private insertAgentOperationAudit(audit: AgentOperationAudit, createdAt: number): void {
    const summary = {
      inputFingerprint: audit.inputFingerprint,
      action: audit.input.action,
      operations:
        audit.input.action === "apply"
          ? audit.input.operations.map((operation) => ({
              type: operation.type,
              blockId: operation.blockId,
            }))
          : [],
    };
    this.durableState.storage.sql.exec(
      `INSERT INTO paca_document_agent_operation_audit
         (request_id, run_id, agent_id, operation_mode, base_revision,
          result_revision, status, operation_summary, result_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      audit.input.requestId,
      audit.input.runId,
      audit.actorId,
      audit.input.operationMode,
      audit.input.action === "apply" ? audit.input.baseRevision : audit.result.revision,
      audit.result.revision,
      audit.status,
      JSON.stringify(summary),
      JSON.stringify(audit.result),
      createdAt,
    );
  }

  private materializationState(): {
    revision: number;
    queuedRevision: number;
    acknowledgedRevision: number;
  } {
    const [row] = this.durableState.storage.sql
      .exec<{ revision: number; queuedRevision: number; acknowledgedRevision: number }>(
        `SELECT revision,
                queued_revision AS queuedRevision,
                acknowledged_revision AS acknowledgedRevision
           FROM paca_document_materialization_state
          WHERE singleton = 1`,
      )
      .toArray();
    if (!row) throw new Error("DOCUMENT_MATERIALIZATION_STATE_MISSING");
    return row;
  }

  private async enqueueMaterialization(): Promise<void> {
    await this.setName(this.name);
    const state = this.materializationState();
    if (
      state.revision <= 0 ||
      state.revision <= state.acknowledgedRevision ||
      state.revision <= state.queuedRevision
    ) {
      return;
    }
    try {
      await this.environment.DOCUMENT_MATERIALIZATION.send({
        kind: "document.materialize",
        version: 1,
        documentId: this.name,
        revision: state.revision,
        createdAt: new Date().toISOString(),
      });
      this.durableState.storage.sql.exec(
        `UPDATE paca_document_materialization_state
            SET queued_revision = max(queued_revision, ?), updated_at = ?
          WHERE singleton = 1`,
        state.revision,
        Date.now(),
      );
      await this.durableState.storage.deleteAlarm();
    } catch (error) {
      await this.durableState.storage.setAlarm(Date.now() + 30_000);
      console.error(
        JSON.stringify({
          event: "document.materialization.enqueue_failed",
          documentId: this.name,
          revision: state.revision,
          errorName: error instanceof Error ? error.name : "UnknownError",
        }),
      );
    }
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
