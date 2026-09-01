import type { Connection, ConnectionContext, WSMessage } from "partyserver";
import { Server } from "partyserver";

import {
  canReceiveRealtimeEvent,
  decodeConnectionState,
  parseRealtimeEnvelope,
  REALTIME_CONTEXT_HEADER,
  type RealtimeConnectionState,
  type RealtimeConnectionStateView,
  realtimeClientMessage,
} from "./protocol";

type RealtimeConnection = Connection<RealtimeConnectionState>;
type InvalidationScope = "actor" | "room" | "session";

const AUTHORIZATION_CLOSE_CODE = 4003;
const AUTHORIZATION_CLOSE_REASON = "realtime authorization changed";

abstract class PacaRealtimeParty extends Server<Env> {
  static override options = { hibernate: true };

  private readonly durableState: DurableObjectState;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.durableState = state;
    state.blockConcurrencyWhile(async () => {
      state.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS paca_realtime_invalidation (
          scope TEXT NOT NULL,
          subject TEXT NOT NULL,
          invalidated_at INTEGER NOT NULL,
          PRIMARY KEY (scope, subject)
        )
      `);
    });
  }

  override getConnectionTags(_connection: Connection, context: ConnectionContext): string[] {
    const state = decodeConnectionState(context.request.headers.get(REALTIME_CONTEXT_HEADER));
    if (!state) return ["unauthenticated"];
    return [
      `actor:${state.actorType}:${state.actorId}`,
      `room:${state.roomType}:${state.roomId}`,
      `permission:${state.permissionVersion}`,
    ];
  }

  override async onConnect(
    connection: RealtimeConnection,
    context: ConnectionContext,
  ): Promise<void> {
    const state = decodeConnectionState(context.request.headers.get(REALTIME_CONTEXT_HEADER));
    if (
      !state ||
      state.roomId !== this.name ||
      state.issuedAt > Date.now() ||
      state.expiresAt <= Date.now() ||
      this.isInvalidated(state)
    ) {
      connection.close(AUTHORIZATION_CLOSE_CODE, "realtime authorization invalid");
      return;
    }
    connection.setState(state);
    connection.send(
      JSON.stringify({
        kind: "ready",
        roomType: state.roomType,
        roomId: state.roomId,
        actorType: state.actorType,
        expiresAt: state.expiresAt,
      }),
    );
  }

  override onMessage(connection: RealtimeConnection, message: WSMessage): void {
    const state = connection.state;
    if (!state || state.expiresAt <= Date.now() || this.isInvalidated(state)) {
      connection.close(AUTHORIZATION_CLOSE_CODE, AUTHORIZATION_CLOSE_REASON);
      return;
    }
    if (typeof message !== "string" || message.length > 1_024) {
      connection.close(4007, "realtime message invalid");
      return;
    }
    try {
      const value = JSON.parse(message) as Record<string, unknown>;
      if (value.type !== "ping") throw new Error("unsupported");
      connection.send(JSON.stringify({ kind: "pong", timestamp: Date.now() }));
    } catch {
      connection.close(4007, "realtime message invalid");
    }
  }

  protected publishAuthorized(value: unknown): number {
    const event = parseRealtimeEnvelope(value);
    const message = JSON.stringify(realtimeClientMessage(event));
    let delivered = 0;
    for (const connection of this.getConnections<RealtimeConnectionState>()) {
      const state = connection.state;
      if (!state || this.isInvalidated(state)) {
        connection.close(AUTHORIZATION_CLOSE_CODE, AUTHORIZATION_CLOSE_REASON);
        continue;
      }
      if (!canReceiveRealtimeEvent(state, event)) continue;
      connection.send(message);
      delivered += 1;
    }
    return delivered;
  }

  invalidateActor(actorType: "user" | "agent", actorId: string): number {
    if (!actorId || actorId.length > 255) throw new Error("REALTIME_ACTOR_INVALID");
    const subject = `${actorType}:${actorId}`;
    this.setInvalidation("actor", subject);
    return this.closeConnections(
      (state) => state.actorType === actorType && state.actorId === actorId,
    );
  }

  invalidateSession(sessionId: string): number {
    if (!sessionId || sessionId.length > 255) throw new Error("REALTIME_SESSION_INVALID");
    this.setInvalidation("session", sessionId);
    return this.closeConnections((state) => state.sessionId === sessionId);
  }

  invalidateAll(): number {
    this.setInvalidation("room", this.name);
    return this.closeConnections(() => true);
  }

  private closeConnections(predicate: (state: RealtimeConnectionStateView) => boolean): number {
    let closed = 0;
    for (const connection of this.getConnections<RealtimeConnectionState>()) {
      const state = connection.state;
      if (!state || !predicate(state)) continue;
      connection.close(AUTHORIZATION_CLOSE_CODE, AUTHORIZATION_CLOSE_REASON);
      closed += 1;
    }
    return closed;
  }

  private isInvalidated(state: RealtimeConnectionStateView): boolean {
    const subjects: Array<[InvalidationScope, string]> = [
      ["room", state.roomId],
      ["actor", `${state.actorType}:${state.actorId}`],
    ];
    if (state.sessionId) subjects.push(["session", state.sessionId]);

    for (const [scope, subject] of subjects) {
      const [row] = this.durableState.storage.sql
        .exec<{ invalidatedAt: number }>(
          `SELECT invalidated_at AS invalidatedAt
             FROM paca_realtime_invalidation
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
      `INSERT INTO paca_realtime_invalidation (scope, subject, invalidated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (scope, subject) DO UPDATE SET
         invalidated_at = max(invalidated_at, excluded.invalidated_at)`,
      scope,
      subject,
      Date.now(),
    );
  }

  override onRequest(): Response {
    return Response.json(
      { status: "error", code: "REALTIME_WEBSOCKET_REQUIRED" },
      { status: 426, headers: { "cache-control": "no-store" } },
    );
  }

  override onException(error: unknown): void {
    console.error(
      JSON.stringify({
        event: "realtime.party.exception",
        party: this.constructor.name,
        roomId: this.name,
        errorName: error instanceof Error ? error.name : "UnknownError",
      }),
    );
  }
}

export class ProjectParty extends PacaRealtimeParty {
  publish(value: unknown): number {
    const event = parseRealtimeEnvelope(value);
    if (event.payload.project_id !== this.name) throw new Error("REALTIME_PROJECT_SCOPE_MISMATCH");
    return this.publishAuthorized(event);
  }
}

export class UserParty extends PacaRealtimeParty {
  publish(value: unknown): number {
    const event = parseRealtimeEnvelope(value);
    const recipient = event.payload.recipient_user_id;
    const actor = event.payload.actor_user_id;
    if (recipient !== this.name && actor !== this.name) {
      throw new Error("REALTIME_USER_SCOPE_MISMATCH");
    }
    return this.publishAuthorized(event);
  }
}
