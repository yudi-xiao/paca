import { describe, expect, it, vi } from "vitest";

import type { AppBindings } from "../src/bindings";
import { consumeRealtimeQueue } from "../src/realtime/consumer";
import type { RealtimeOutboxRepository } from "../src/realtime/outbox";

const NOW = new Date("2026-09-01T00:00:00.000Z");
const OUTBOX_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

function store(): RealtimeOutboxRepository {
  return {
    claim: vi.fn(),
    markEnqueued: vi.fn(),
    release: vi.fn(),
    markDelivered: vi.fn().mockResolvedValue(undefined),
  };
}

function message(body: unknown, attempts = 1) {
  return {
    id: "queue-message-1",
    timestamp: NOW,
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function batch(queueMessage: ReturnType<typeof message>): MessageBatch<unknown> {
  return {
    queue: "paca-realtime-events-test",
    metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
    messages: [queueMessage],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  };
}

function event() {
  return {
    version: 1,
    outboxId: OUTBOX_ID,
    roomType: "project",
    roomId: PROJECT_ID,
    event: {
      type: "task.updated",
      payload: { project_id: PROJECT_ID, task_id: "task-1" },
    },
    createdAt: NOW.toISOString(),
  };
}

describe("realtime Queue consumer", () => {
  it("publishes through the scoped Party and acknowledges after outbox delivery is recorded", async () => {
    const queueMessage = message(event());
    const repository = store();
    const publishReliable = vi.fn().mockResolvedValue({ delivered: 1, duplicate: false });

    await consumeRealtimeQueue(batch(queueMessage), {} as AppBindings, {
      now: () => NOW,
      repository,
      projectParty: { getByName: vi.fn(() => ({ publishReliable })) },
    });

    expect(publishReliable).toHaveBeenCalledWith(event());
    expect(repository.markDelivered).toHaveBeenCalledWith(OUTBOX_ID, NOW);
    expect(queueMessage.ack).toHaveBeenCalledOnce();
    expect(queueMessage.retry).not.toHaveBeenCalled();
  });

  it("retries a Party delivery failure with bounded exponential delay", async () => {
    const queueMessage = message(event(), 4);
    const repository = store();

    await consumeRealtimeQueue(batch(queueMessage), {} as AppBindings, {
      repository,
      projectParty: {
        getByName: vi.fn(() => ({
          publishReliable: vi.fn().mockRejectedValue(new Error("PARTY_UNAVAILABLE")),
        })),
      },
    });

    expect(queueMessage.retry).toHaveBeenCalledWith({ delaySeconds: 40 });
    expect(queueMessage.ack).not.toHaveBeenCalled();
    expect(repository.markDelivered).not.toHaveBeenCalled();
  });

  it("acknowledges malformed poison messages without invoking a Party", async () => {
    const queueMessage = message({ version: 99 });
    const repository = store();
    const getByName = vi.fn();

    await consumeRealtimeQueue(batch(queueMessage), {} as AppBindings, {
      repository,
      projectParty: { getByName },
    });

    expect(queueMessage.ack).toHaveBeenCalledOnce();
    expect(queueMessage.retry).not.toHaveBeenCalled();
    expect(getByName).not.toHaveBeenCalled();
  });
});
