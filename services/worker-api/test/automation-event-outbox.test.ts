import { describe, expect, it, vi } from "vitest";

import { consumeAutomationEventQueue } from "../src/automation/event-consumer";
import {
  type AutomationEventRow,
  type AutomationOutboxRepository,
  dispatchAutomationOutbox,
} from "../src/automation/event-outbox";
import type { AutomationRunPlanner } from "../src/automation/run-planner";
import type { AppBindings } from "../src/bindings";

const now = new Date("2026-09-28T00:00:00.000Z");
const outboxId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";

function event(): AutomationEventRow {
  return {
    id: outboxId,
    projectId,
    taskId,
    eventType: "task_created",
    payload: { task_id: taskId, status_id: null },
    status: "pending",
    attempts: 0,
    availableAt: now,
    leaseExpiresAt: null,
    enqueuedAt: null,
    deliveredAt: null,
    failureCode: null,
    createdAt: now,
    updatedAt: now,
  };
}

function repository(row: AutomationEventRow | null = event()): AutomationOutboxRepository {
  return {
    claim: vi.fn().mockResolvedValue(row ? [row] : []),
    markEnqueued: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(row),
    markDelivered: vi.fn().mockResolvedValue(undefined),
  };
}

function batch(body: unknown) {
  const ack = vi.fn();
  const retry = vi.fn();
  return {
    ack,
    retry,
    value: {
      queue: "paca-automation-events-internal",
      messages: [{ id: "message-1", timestamp: now, body, attempts: 1, ack, retry }],
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      retryAll: vi.fn(),
      ackAll: vi.fn(),
    } satisfies MessageBatch<unknown>,
  };
}

describe("automation event outbox", () => {
  it("sends only durable row IDs and marks the batch enqueued after Queue accepts it", async () => {
    const store = repository();
    const queue = { sendBatch: vi.fn().mockResolvedValue(undefined) };
    await expect(
      dispatchAutomationOutbox({} as AppBindings, { now, repository: store, queue }),
    ).resolves.toEqual({ claimed: 1, enqueued: 1, failed: 0 });
    expect(queue.sendBatch).toHaveBeenCalledWith([
      { body: { version: 1, outboxId }, contentType: "json" },
    ]);
    expect(store.markEnqueued).toHaveBeenCalledWith([outboxId], now);
    expect(store.release).not.toHaveBeenCalled();
  });

  it("releases a claim when Queue send fails", async () => {
    const store = repository();
    const queue = { sendBatch: vi.fn().mockRejectedValue(new Error("QUEUE_UNAVAILABLE")) };
    await expect(
      dispatchAutomationOutbox({} as AppBindings, { now, repository: store, queue }),
    ).resolves.toEqual({ claimed: 1, enqueued: 0, failed: 1 });
    expect(store.release).toHaveBeenCalledWith([outboxId], now, "QUEUE_UNAVAILABLE");
    expect(store.markEnqueued).not.toHaveBeenCalled();
  });

  it("acknowledges events without matching runs and starts matched runs before delivery", async () => {
    const store = repository();
    const planner: AutomationRunPlanner = { plan: vi.fn().mockResolvedValue([]) };
    const workflow = { createBatch: vi.fn().mockResolvedValue([]) };
    const inactiveMessage = batch({ version: 1, outboxId });
    await consumeAutomationEventQueue(inactiveMessage.value, {} as AppBindings, {
      repository: store,
      planner,
      workflow,
      now: () => now,
    });
    expect(store.markDelivered).toHaveBeenCalledWith(outboxId, now);
    expect(inactiveMessage.ack).toHaveBeenCalledOnce();
    expect(workflow.createBatch).not.toHaveBeenCalled();

    const activeStore = repository();
    const activeMessage = batch({ version: 1, outboxId });
    await consumeAutomationEventQueue(activeMessage.value, {} as AppBindings, {
      repository: activeStore,
      planner: { plan: vi.fn().mockResolvedValue([runId]) },
      workflow,
      now: () => now,
    });
    expect(workflow.createBatch).toHaveBeenCalledWith([{ id: runId, params: { runId } }]);
    expect(activeStore.markDelivered).toHaveBeenCalledWith(outboxId, now);
    expect(activeMessage.ack).toHaveBeenCalledOnce();
  });

  it("does not acknowledge an event when Workflow creation fails", async () => {
    const store = repository();
    const message = batch({ version: 1, outboxId });
    await consumeAutomationEventQueue(message.value, {} as AppBindings, {
      repository: store,
      planner: { plan: vi.fn().mockResolvedValue([runId]) },
      workflow: { createBatch: vi.fn().mockRejectedValue(new Error("WORKFLOW_UNAVAILABLE")) },
    });
    expect(store.markDelivered).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
  });

  it("acks invalid or duplicate messages without replaying the event", async () => {
    const store = repository({ ...event(), status: "delivered", deliveredAt: now });
    const invalid = batch({ version: 1, outboxId: "not-a-uuid" });
    await consumeAutomationEventQueue(invalid.value, {} as AppBindings, {
      repository: store,
      planner: { plan: vi.fn().mockResolvedValue([runId]) },
      workflow: { createBatch: vi.fn().mockResolvedValue([]) },
    });
    expect(invalid.ack).toHaveBeenCalledOnce();
    const duplicate = batch({ version: 1, outboxId });
    await consumeAutomationEventQueue(duplicate.value, {} as AppBindings, {
      repository: store,
      planner: { plan: vi.fn().mockResolvedValue([runId]) },
      workflow: { createBatch: vi.fn().mockResolvedValue([]) },
    });
    expect(duplicate.ack).toHaveBeenCalledOnce();
    expect(store.markDelivered).not.toHaveBeenCalled();
  });
});
