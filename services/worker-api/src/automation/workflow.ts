import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { and, eq } from "drizzle-orm";
import * as z from "zod";

import { withDatabase } from "../database";
import { pacaAutomationRunSteps, pacaAutomationRuns } from "../db/schema";
import { PostgresTaskRepository } from "../task/postgres-repository";
import { automationTaskActor, TaskService } from "../task/service";
import { orderedReachableNodes, taskUpdateFromNode, waitMinutes } from "./execution-plan";
import {
  type AutomationWorkflowParams,
  automationRunSnapshotSchema,
  automationWorkflowParamsSchema,
} from "./run-protocol";

const RETRY = {
  retries: { limit: 4, delay: "2 seconds", backoff: "exponential" as const },
  timeout: "2 minutes",
} as const;

const loadedRunSchema = z
  .object({
    status: z.enum(["running", "completed", "failed"]),
    triggerNodeId: z.uuid(),
    snapshot: automationRunSnapshotSchema,
  })
  .strict();

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && /^AUTOMATION_[A-Z0-9_]{1,90}$/u.test(error.message)) {
    return error.message;
  }
  return "AUTOMATION_WORKFLOW_FAILED";
}

export class AutomationWorkflow extends WorkflowEntrypoint<Env, AutomationWorkflowParams> {
  override async run(event: Readonly<WorkflowEvent<AutomationWorkflowParams>>, step: WorkflowStep) {
    const params = automationWorkflowParamsSchema.parse(event.payload);
    let failedNodeId: string | null = null;
    try {
      const serializedRun = await step.do("load-run-snapshot", RETRY, () =>
        withDatabase(this.env, async (database) => {
          const [row] = await database
            .select({
              status: pacaAutomationRuns.status,
              triggerNodeId: pacaAutomationRuns.triggerNodeId,
              graphSnapshot: pacaAutomationRuns.graphSnapshot,
            })
            .from(pacaAutomationRuns)
            .where(eq(pacaAutomationRuns.id, params.runId));
          if (!row) throw new Error("AUTOMATION_RUN_NOT_FOUND");
          return JSON.stringify({
            status: row.status,
            triggerNodeId: row.triggerNodeId,
            snapshot: automationRunSnapshotSchema.parse(row.graphSnapshot),
          });
        }),
      );
      const run = loadedRunSchema.parse(JSON.parse(serializedRun));
      if (run.status !== "running") return { status: run.status };

      for (const node of orderedReachableNodes(run.snapshot, run.triggerNodeId)) {
        if (node.id === run.triggerNodeId) continue;
        failedNodeId = node.id;
        if (node.type === "wait") {
          const minutes = waitMinutes(node);
          await step.sleep(`wait-${node.id}`, `${minutes} minutes`);
          await step.do(`record-wait-${node.id}`, RETRY, () =>
            withDatabase(this.env, async (database) => {
              await database
                .insert(pacaAutomationRunSteps)
                .values({
                  runId: params.runId,
                  nodeId: node.id,
                  stepKey: node.id,
                  status: "completed",
                  inputSnapshot: { wait_minutes: minutes },
                  outputSnapshot: { waited: true },
                })
                .onConflictDoNothing({
                  target: [pacaAutomationRunSteps.runId, pacaAutomationRunSteps.stepKey],
                });
            }),
          );
          continue;
        }
        const update = taskUpdateFromNode(node);
        await step.do(`update-task-${node.id}`, RETRY, () =>
          withDatabase(this.env, async (database) => {
            const service = new TaskService(new PostgresTaskRepository(database));
            const task = await service.updateAs(
              run.snapshot.projectId,
              run.snapshot.event.taskId,
              automationTaskActor(params.runId),
              update,
              `${params.runId}:${node.id}`,
            );
            return task.id;
          }),
        );
        await step.do(`record-update-task-${node.id}`, RETRY, () =>
          withDatabase(this.env, async (database) => {
            await database
              .insert(pacaAutomationRunSteps)
              .values({
                runId: params.runId,
                nodeId: node.id,
                stepKey: node.id,
                status: "completed",
                inputSnapshot: {
                  fields: Object.entries(update)
                    .filter(([, value]) => value !== undefined)
                    .map(([key]) => key),
                },
                outputSnapshot: { task_id: run.snapshot.event.taskId },
              })
              .onConflictDoNothing({
                target: [pacaAutomationRunSteps.runId, pacaAutomationRunSteps.stepKey],
              });
          }),
        );
      }
      await step.do("mark-run-completed", RETRY, () =>
        withDatabase(this.env, async (database) => {
          await database
            .update(pacaAutomationRuns)
            .set({ status: "completed", finishedAt: new Date() })
            .where(
              and(
                eq(pacaAutomationRuns.id, params.runId),
                eq(pacaAutomationRuns.status, "running"),
              ),
            );
        }),
      );
      return { status: "completed" as const };
    } catch (error) {
      const code = safeErrorCode(error);
      await step.do("mark-run-failed", RETRY, () =>
        withDatabase(this.env, async (database) => {
          await database.transaction(async (tx) => {
            if (failedNodeId) {
              await tx
                .insert(pacaAutomationRunSteps)
                .values({
                  runId: params.runId,
                  nodeId: failedNodeId,
                  stepKey: failedNodeId,
                  status: "failed",
                  errorCode: code,
                })
                .onConflictDoNothing({
                  target: [pacaAutomationRunSteps.runId, pacaAutomationRunSteps.stepKey],
                });
            }
            await tx
              .update(pacaAutomationRuns)
              .set({ status: "failed", finishedAt: new Date() })
              .where(
                and(
                  eq(pacaAutomationRuns.id, params.runId),
                  eq(pacaAutomationRuns.status, "running"),
                ),
              );
          });
        }),
      );
      throw new NonRetryableError(code);
    }
  }
}
