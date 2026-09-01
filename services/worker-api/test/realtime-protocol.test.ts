import { describe, expect, it } from "vitest";

import {
  canReceiveRealtimeEvent,
  decodeConnectionState,
  encodeConnectionState,
  parseRealtimeEnvelope,
  REALTIME_MAX_EVENT_BYTES,
  type RealtimeConnectionState,
  realtimeClientMessage,
  realtimeEventNamespace,
} from "../src/realtime/protocol";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const DOCUMENT_ID = "33333333-3333-4333-8333-333333333333";
const NOW = Date.parse("2026-08-31T00:00:00.000Z");

function state(overrides: Partial<RealtimeConnectionState> = {}): RealtimeConnectionState {
  return {
    version: 1,
    actorType: "user",
    actorId: "user-1",
    sessionId: "session-1",
    roomType: "project",
    roomId: PROJECT_ID,
    namespaces: ["tasks", "docs", "workflows", "sprints"],
    taskIds: [],
    documentIds: [],
    issuedAt: NOW - 1_000,
    expiresAt: NOW + 60_000,
    nonce: "44444444-4444-4444-8444-444444444444",
    permissionVersion: "a".repeat(64),
    ...overrides,
  };
}

describe("realtime protocol", () => {
  it("round-trips a normalized, bounded connection attachment", () => {
    const encoded = encodeConnectionState(
      state({ namespaces: ["tasks", "tasks"], taskIds: [TASK_ID, TASK_ID] }),
    );

    expect(decodeConnectionState(encoded)).toMatchObject({
      namespaces: ["tasks"],
      taskIds: [TASK_ID],
    });
    expect(decodeConnectionState("not-json")).toBeNull();
  });

  it("preserves the legacy namespace contract including automation events", () => {
    expect(realtimeEventNamespace("task.updated")).toBe("tasks");
    expect(realtimeEventNamespace("workflow.assigned")).toBe("tasks");
    expect(realtimeEventNamespace("workflow.completed")).toBe("workflows");
    expect(realtimeEventNamespace("automation.executed")).toBe("workflows");
    expect(realtimeEventNamespace("doc.updated")).toBe("docs");
    expect(realtimeEventNamespace("view.updated")).toBe("sprints");
    expect(realtimeEventNamespace("unknown.event")).toBeNull();
  });

  it("filters project events by namespace and project", () => {
    const taskEvent = parseRealtimeEnvelope({
      type: "task.updated",
      payload: { project_id: PROJECT_ID, task_id: TASK_ID },
    });

    expect(canReceiveRealtimeEvent(state({ namespaces: ["tasks"] }), taskEvent, NOW)).toBe(true);
    expect(canReceiveRealtimeEvent(state({ namespaces: ["docs"] }), taskEvent, NOW)).toBe(false);
    expect(
      canReceiveRealtimeEvent(
        state({ roomId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
        taskEvent,
        NOW,
      ),
    ).toBe(false);
    expect(canReceiveRealtimeEvent(state({ expiresAt: NOW }), taskEvent, NOW)).toBe(false);
  });

  it("limits Agent subscriptions to the exact granted task or document", () => {
    const agentState = state({
      actorType: "agent",
      actorId: "agent-1",
      sessionId: null,
      namespaces: ["tasks", "docs"],
      taskIds: [TASK_ID],
      documentIds: [DOCUMENT_ID],
    });

    expect(
      canReceiveRealtimeEvent(
        agentState,
        { type: "task.updated", payload: { project_id: PROJECT_ID, task_id: TASK_ID } },
        NOW,
      ),
    ).toBe(true);
    expect(
      canReceiveRealtimeEvent(
        agentState,
        {
          type: "task.updated",
          payload: {
            project_id: PROJECT_ID,
            task_id: "55555555-5555-4555-8555-555555555555",
          },
        },
        NOW,
      ),
    ).toBe(false);
    expect(
      canReceiveRealtimeEvent(
        agentState,
        { type: "doc.updated", payload: { project_id: PROJECT_ID, document_id: DOCUMENT_ID } },
        NOW,
      ),
    ).toBe(true);
    expect(
      canReceiveRealtimeEvent(
        agentState,
        { type: "workflow.updated", payload: { project_id: PROJECT_ID } },
        NOW,
      ),
    ).toBe(false);
  });

  it("keeps user rooms private and emits the client compatibility envelope", () => {
    const userState = state({
      roomType: "user",
      roomId: "user-1",
      namespaces: [],
    });
    const notification = {
      type: "notification.created",
      payload: { recipient_user_id: "user-1" },
    };

    expect(canReceiveRealtimeEvent(userState, notification, NOW)).toBe(true);
    expect(
      canReceiveRealtimeEvent(
        userState,
        { type: "notification.created", payload: { recipient_user_id: "user-2" } },
        NOW,
      ),
    ).toBe(false);
    expect(realtimeClientMessage(notification)).toEqual({
      kind: "notification",
      type: notification.type,
      payload: notification.payload,
    });
  });

  it("rejects oversized server events", () => {
    expect(() =>
      parseRealtimeEnvelope({
        type: "task.updated",
        payload: { body: "x".repeat(REALTIME_MAX_EVENT_BYTES) },
      }),
    ).toThrow("REALTIME_EVENT_TOO_LARGE");
  });
});
