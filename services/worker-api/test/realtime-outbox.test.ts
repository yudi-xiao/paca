import { describe, expect, it, vi } from "vitest";

import type { AppBindings } from "../src/bindings";
import { dispatchRealtimeOutbox, type RealtimeOutboxRepository } from "../src/realtime/outbox";

const NOW = new Date("2026-09-01T00:00:00.000Z");
const OUTBOX_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

function row() {
  return {
    id: OUTBOX_ID,
    roomType: "project" as const,
    roomId: PROJECT_ID,
    eventType: "task.updated",
    payload: { project_id: PROJECT_ID, task_id: "task-1" },
    status: "pending" as const,
    attempts: 0,
    availableAt: NOW,
    leaseExpiresAt: null,
    enqueuedAt: null,
    deliveredAt: null,
    failureCode: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function repository(): RealtimeOutboxRepository {
  return {
    claim: vi.fn().mockResolvedValue([row()]),
    markEnqueued: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
    markDelivered: vi.fn().mockResolvedValue(undefined),
  };
}

describe("realtime outbox dispatcher", () => {
  it("claims, validates and batch-enqueues events before marking them enqueued", async () => {
    const store = repository();
    const queue = { sendBatch: vi.fn().mockResolvedValue(undefined) };

    await expect(
      dispatchRealtimeOutbox({} as AppBindings, { now: NOW, repository: store, queue }),
    ).resolves.toEqual({ claimed: 1, enqueued: 1, failed: 0 });

    expect(queue.sendBatch).toHaveBeenCalledWith([
      {
        contentType: "json",
        body: {
          version: 1,
          outboxId: OUTBOX_ID,
          roomType: "project",
          roomId: PROJECT_ID,
          event: {
            type: "task.updated",
            payload: { project_id: PROJECT_ID, task_id: "task-1" },
          },
          createdAt: NOW.toISOString(),
        },
      },
    ]);
    expect(store.markEnqueued).toHaveBeenCalledWith([OUTBOX_ID], NOW);
    expect(store.release).not.toHaveBeenCalled();
  });

  it("releases a claimed batch for delayed recovery when Queue send fails", async () => {
    const store = repository();
    const queue = { sendBatch: vi.fn().mockRejectedValue(new Error("QUEUE_UNAVAILABLE")) };

    await expect(
      dispatchRealtimeOutbox({} as AppBindings, { now: NOW, repository: store, queue }),
    ).resolves.toEqual({ claimed: 1, enqueued: 0, failed: 1 });

    expect(store.release).toHaveBeenCalledWith([OUTBOX_ID], NOW, "QUEUE_UNAVAILABLE");
    expect(store.markEnqueued).not.toHaveBeenCalled();
  });
});
