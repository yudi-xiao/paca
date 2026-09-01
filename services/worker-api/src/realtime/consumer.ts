import type { AppBindings } from "../bindings";
import { withDatabase } from "../database";
import { PostgresRealtimeOutboxRepository, type RealtimeOutboxRepository } from "./outbox";
import { parseRealtimeQueueMessage, type RealtimeQueueMessage } from "./queue-protocol";

type RealtimePartyStub = {
  publishReliable(value: unknown): Promise<{ delivered: number; duplicate: boolean }>;
};

type RealtimePartyNamespace = {
  getByName(name: string): RealtimePartyStub;
};

export type RealtimeQueueConsumerDependencies = {
  now?: () => Date;
  repository?: RealtimeOutboxRepository;
  projectParty?: RealtimePartyNamespace;
  userParty?: RealtimePartyNamespace;
};

function retryDelay(attempts: number): number {
  return Math.min(300, 5 * 2 ** Math.min(Math.max(attempts - 1, 0), 6));
}

function errorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message)) return error.message;
  return "REALTIME_QUEUE_DELIVERY_FAILED";
}

async function consumeWithRepository(
  batch: MessageBatch<unknown>,
  env: AppBindings,
  repository: RealtimeOutboxRepository,
  dependencies: RealtimeQueueConsumerDependencies,
): Promise<void> {
  for (const queueMessage of batch.messages) {
    let event: RealtimeQueueMessage;
    try {
      event = parseRealtimeQueueMessage(queueMessage.body);
    } catch {
      console.error(
        JSON.stringify({
          event: "realtime.queue.invalid_message",
          queueMessageId: queueMessage.id,
        }),
      );
      queueMessage.ack();
      continue;
    }

    try {
      const namespace =
        event.roomType === "project"
          ? (dependencies.projectParty ?? env.ProjectParty)
          : (dependencies.userParty ?? env.UserParty);
      await namespace.getByName(event.roomId).publishReliable(event);
      await repository.markDelivered(event.outboxId, (dependencies.now ?? (() => new Date()))());
      queueMessage.ack();
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "realtime.queue.delivery_failed",
          outboxId: event.outboxId,
          roomType: event.roomType,
          roomId: event.roomId,
          errorCode: errorCode(error),
          attempts: queueMessage.attempts,
        }),
      );
      queueMessage.retry({ delaySeconds: retryDelay(queueMessage.attempts) });
    }
  }
}

export async function consumeRealtimeQueue(
  batch: MessageBatch<unknown>,
  env: AppBindings,
  dependencies: RealtimeQueueConsumerDependencies = {},
): Promise<void> {
  if (dependencies.repository) {
    return consumeWithRepository(batch, env, dependencies.repository, dependencies);
  }
  return withDatabase(env, (database) =>
    consumeWithRepository(batch, env, new PostgresRealtimeOutboxRepository(database), dependencies),
  );
}
