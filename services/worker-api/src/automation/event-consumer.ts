import { and, eq, isNull } from "drizzle-orm";

import type { AppBindings } from "../bindings";
import { type PacaDatabase, withDatabase } from "../database";
import { pacaAutomationNodes, pacaAutomations } from "../db/schema";
import {
  type AutomationEventRow,
  type AutomationOutboxRepository,
  PostgresAutomationOutboxRepository,
  parseAutomationQueueMessage,
} from "./event-outbox";

type AutomationEventConsumerDependencies = {
  now?: () => Date;
  repository?: AutomationOutboxRepository;
  hasActiveTrigger?: (event: AutomationEventRow) => Promise<boolean>;
};

async function hasActiveTrigger(
  database: PacaDatabase,
  event: AutomationEventRow,
): Promise<boolean> {
  const [match] = await database
    .select({ id: pacaAutomations.id })
    .from(pacaAutomations)
    .innerJoin(pacaAutomationNodes, eq(pacaAutomationNodes.automationId, pacaAutomations.id))
    .where(
      and(
        eq(pacaAutomations.projectId, event.projectId),
        eq(pacaAutomations.status, "active"),
        isNull(pacaAutomations.deletedAt),
        eq(pacaAutomationNodes.kind, "trigger"),
        eq(pacaAutomationNodes.type, event.eventType),
      ),
    )
    .limit(1);
  return Boolean(match);
}

async function consume(
  batch: MessageBatch<unknown>,
  repository: AutomationOutboxRepository,
  matches: (event: AutomationEventRow) => Promise<boolean>,
  now: () => Date,
): Promise<void> {
  for (const message of batch.messages) {
    let outboxId: string;
    try {
      outboxId = parseAutomationQueueMessage(message.body).outboxId;
    } catch {
      console.error(
        JSON.stringify({ event: "automation.queue.invalid_message", queueMessageId: message.id }),
      );
      message.ack();
      continue;
    }

    try {
      const event = await repository.get(outboxId);
      if (!event || event.status === "delivered") {
        message.ack();
        continue;
      }
      // Activation is still closed. If an active graph was installed out of
      // band, fail closed and leave the durable outbox row recoverable rather
      // than acknowledging an event whose actions were never executed.
      if (await matches(event)) throw new Error("AUTOMATION_EXECUTOR_NOT_READY");
      await repository.markDelivered(outboxId, now());
      message.ack();
    } catch (error) {
      const errorCode =
        error instanceof Error && /^[A-Z0-9_]{1,100}$/u.test(error.message)
          ? error.message
          : "AUTOMATION_EVENT_CONSUME_FAILED";
      console.error(
        JSON.stringify({
          event: "automation.queue.delivery_failed",
          outboxId,
          errorCode,
          attempts: message.attempts,
        }),
      );
      message.retry({ delaySeconds: Math.min(300, 5 * 2 ** Math.min(message.attempts, 6)) });
    }
  }
}

export async function consumeAutomationEventQueue(
  batch: MessageBatch<unknown>,
  env: AppBindings,
  dependencies: AutomationEventConsumerDependencies = {},
): Promise<void> {
  const now = dependencies.now ?? (() => new Date());
  if (dependencies.repository && dependencies.hasActiveTrigger) {
    return consume(batch, dependencies.repository, dependencies.hasActiveTrigger, now);
  }
  return withDatabase(env, (database) =>
    consume(
      batch,
      dependencies.repository ?? new PostgresAutomationOutboxRepository(database),
      dependencies.hasActiveTrigger ?? ((event) => hasActiveTrigger(database, event)),
      now,
    ),
  );
}
