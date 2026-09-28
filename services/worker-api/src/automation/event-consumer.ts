import type { AppBindings } from "../bindings";
import { withDatabase } from "../database";
import {
  type AutomationOutboxRepository,
  PostgresAutomationOutboxRepository,
  parseAutomationQueueMessage,
} from "./event-outbox";
import { type AutomationRunPlanner, PostgresAutomationRunPlanner } from "./run-planner";
import type { AutomationWorkflowParams } from "./run-protocol";

type WorkflowStarter = Pick<Workflow<AutomationWorkflowParams>, "createBatch">;

export type AutomationEventConsumerDependencies = {
  now?: () => Date;
  repository?: AutomationOutboxRepository;
  planner?: AutomationRunPlanner;
  workflow?: WorkflowStarter;
};

async function startRuns(workflow: WorkflowStarter, runIds: string[]): Promise<void> {
  // Cloudflare documents createBatch with caller-supplied IDs as idempotent.
  // A Queue retry can safely re-submit a batch after an uncertain response.
  for (let index = 0; index < runIds.length; index += 100) {
    await workflow.createBatch(
      runIds.slice(index, index + 100).map((runId) => ({ id: runId, params: { runId } })),
    );
  }
}

async function consume(
  batch: MessageBatch<unknown>,
  repository: AutomationOutboxRepository,
  planner: AutomationRunPlanner,
  workflow: WorkflowStarter,
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
      const runIds = await planner.plan(outboxId);
      await startRuns(workflow, runIds);
      await repository.markDelivered(outboxId, now());
      message.ack();
    } catch (error) {
      const errorCode =
        error instanceof Error && /^AUTOMATION_[A-Z0-9_]{1,90}$/u.test(error.message)
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
  if (dependencies.repository && dependencies.planner) {
    return consume(
      batch,
      dependencies.repository,
      dependencies.planner,
      dependencies.workflow ?? env.AUTOMATION_WORKFLOW,
      now,
    );
  }
  return withDatabase(env, (database) =>
    consume(
      batch,
      dependencies.repository ?? new PostgresAutomationOutboxRepository(database),
      dependencies.planner ?? new PostgresAutomationRunPlanner(database),
      dependencies.workflow ?? env.AUTOMATION_WORKFLOW,
      now,
    ),
  );
}
