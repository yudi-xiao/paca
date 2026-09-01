/// <reference types="@cloudflare/vitest-plugin/types" />

import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  encodeConnectionState,
  REALTIME_CONTEXT_HEADER,
  type RealtimeConnectionState,
} from "../../src/realtime/protocol";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

function connectionState(
  overrides: Partial<RealtimeConnectionState> = {},
): RealtimeConnectionState {
  const now = Date.now();
  return {
    version: 1,
    actorType: "user",
    actorId: "user-1",
    sessionId: "session-1",
    roomType: "project",
    roomId: PROJECT_ID,
    namespaces: ["tasks"],
    taskIds: [],
    documentIds: [],
    issuedAt: now,
    expiresAt: now + 60_000,
    nonce: crypto.randomUUID(),
    permissionVersion: "a".repeat(64),
    ...overrides,
  };
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WEBSOCKET_MESSAGE_TIMEOUT")), 5_000);
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timeout);
        resolve(String(event.data));
      },
      { once: true },
    );
  });
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

async function connect(state: RealtimeConnectionState) {
  const stub = env.ProjectParty.getByName(PROJECT_ID);
  const response = await stub.fetch(`https://example.test/ws/parties/project-party/${PROJECT_ID}`, {
    headers: {
      Upgrade: "websocket",
      [REALTIME_CONTEXT_HEADER]: encodeConnectionState(state),
    },
  });
  const socket = response.webSocket;
  if (!socket) throw new Error("WEBSOCKET_RESPONSE_MISSING");
  socket.accept();
  return { socket, stub };
}

describe("PartyServer Durable Object runtime", () => {
  it("restores the trusted connection attachment after hibernation eviction", async () => {
    const { socket, stub } = await connect(connectionState());

    expect(JSON.parse(await nextMessage(socket))).toMatchObject({
      kind: "ready",
      actorType: "user",
      roomType: "project",
      roomId: PROJECT_ID,
    });

    await evictDurableObject(stub, { webSockets: "hibernate" });

    const pong = nextMessage(socket);
    socket.send(JSON.stringify({ type: "ping" }));
    expect(JSON.parse(await pong)).toMatchObject({ kind: "pong" });
    socket.close(1000, "done");
  });

  it("persists revocation state and closes matching sockets after hibernation", async () => {
    const issuedAt = Date.now();
    const { socket, stub } = await connect(connectionState({ issuedAt }));
    await nextMessage(socket);
    await evictDurableObject(stub, { webSockets: "hibernate" });

    const closed = nextClose(socket);
    expect(await stub.invalidateActor("user", "user-1")).toBe(1);
    await expect(closed).resolves.toMatchObject({ code: 4003 });

    const stale = await connect(
      connectionState({
        issuedAt,
        expiresAt: issuedAt + 60_000,
        nonce: crypto.randomUUID(),
      }),
    );
    const staleClosed = nextClose(stale.socket);
    await expect(staleClosed).resolves.toMatchObject({ code: 4003 });
  });

  it("delivers an outbox event once and persists its idempotency key across eviction", async () => {
    const { socket, stub } = await connect(connectionState());
    await nextMessage(socket);
    const outboxId = "55555555-5555-4555-8555-555555555555";
    const value = {
      version: 1 as const,
      outboxId,
      roomType: "project" as const,
      roomId: PROJECT_ID,
      event: {
        type: "task.updated",
        payload: { project_id: PROJECT_ID, task_id: "task-1" },
      },
      createdAt: new Date().toISOString(),
    };

    const delivered = nextMessage(socket);
    await expect(stub.publishReliable(value)).resolves.toEqual({ delivered: 1, duplicate: false });
    expect(JSON.parse(await delivered)).toMatchObject({
      id: outboxId,
      kind: "event",
      type: "task.updated",
    });

    await evictDurableObject(stub, { webSockets: "hibernate" });
    await expect(stub.publishReliable(value)).resolves.toEqual({ delivered: 0, duplicate: true });
    socket.close(1000, "done");
  });
});
