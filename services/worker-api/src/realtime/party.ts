import type { Connection, ConnectionContext, WSMessage } from "partyserver";
import { Server } from "partyserver";

import {
  canReceiveRealtimeEvent,
  decodeConnectionState,
  parseRealtimeEnvelope,
  REALTIME_CONTEXT_HEADER,
  type RealtimeConnectionState,
  realtimeClientMessage,
} from "./protocol";

type RealtimeConnection = Connection<RealtimeConnectionState>;

abstract class PacaRealtimeParty extends Server<Env> {
  static override options = { hibernate: true };

  override getConnectionTags(_connection: Connection, context: ConnectionContext): string[] {
    const state = decodeConnectionState(context.request.headers.get(REALTIME_CONTEXT_HEADER));
    if (!state) return ["unauthenticated"];
    return [`actor:${state.actorType}:${state.actorId}`, `room:${state.roomType}:${state.roomId}`];
  }

  override onConnect(connection: RealtimeConnection, context: ConnectionContext): void {
    const state = decodeConnectionState(context.request.headers.get(REALTIME_CONTEXT_HEADER));
    if (!state || state.roomId !== this.name || state.expiresAt <= Date.now()) {
      connection.close(4003, "realtime authorization invalid");
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
    if (!state || state.expiresAt <= Date.now()) {
      connection.close(4003, "realtime authorization expired");
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
      if (!state || !canReceiveRealtimeEvent(state, event)) continue;
      connection.send(message);
      delivered += 1;
    }
    return delivered;
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
