import { and, asc, eq, inArray, isNull, like, lte } from "drizzle-orm";

import type { PacaDatabase } from "../database";
import {
  pacaAutomationEdges,
  pacaAutomationEventOutbox,
  pacaAutomationNodes,
  pacaAutomationRuns,
  pacaAutomations,
  pacaTaskStatuses,
  pacaTasks,
} from "../db/schema";
import {
  matchesTaskTrigger,
  predecessorDoneTriggerConfigFromNode,
  validateRunnableAutomationGraph,
} from "./execution-plan";
import type { AutomationRunSnapshot } from "./run-protocol";

export type AutomationRunPlanner = {
  plan(outboxId: string): Promise<string[]>;
};

export class PostgresAutomationRunPlanner implements AutomationRunPlanner {
  constructor(private readonly database: PacaDatabase) {}

  async plan(outboxId: string): Promise<string[]> {
    return this.database.transaction(
      async (tx) => {
        const [event] = await tx
          .select()
          .from(pacaAutomationEventOutbox)
          .where(eq(pacaAutomationEventOutbox.id, outboxId));
        if (!event || event.status === "delivered") return [];
        if (!event.taskId) throw new Error("AUTOMATION_EVENT_TASK_MISSING");
        if (
          event.eventType !== "task_created" &&
          event.eventType !== "status_changed" &&
          event.eventType !== "assignee_changed" &&
          event.eventType !== "priority_changed" &&
          event.eventType !== "tag_added" &&
          event.eventType !== "predecessor_done"
        ) {
          throw new Error("AUTOMATION_EVENT_TYPE_UNSUPPORTED");
        }

        // A previous delivery may have persisted a Run but failed while starting its
        // Workflow. Keep that Run eligible even if the graph was edited afterwards.
        const existingRuns = await tx
          .select({ id: pacaAutomationRuns.id })
          .from(pacaAutomationRuns)
          .innerJoin(pacaAutomations, eq(pacaAutomationRuns.automationId, pacaAutomations.id))
          .where(
            and(
              eq(pacaAutomations.projectId, event.projectId),
              eq(pacaAutomationRuns.status, "running"),
              like(pacaAutomationRuns.eventKey, `${event.id}:%`),
            ),
          );
        const runIds = new Set(existingRuns.map((run) => run.id));

        const candidates = await tx
          .select({ automation: pacaAutomations, trigger: pacaAutomationNodes })
          .from(pacaAutomations)
          .innerJoin(pacaAutomationNodes, eq(pacaAutomationNodes.automationId, pacaAutomations.id))
          .where(
            and(
              eq(pacaAutomations.projectId, event.projectId),
              eq(pacaAutomations.status, "active"),
              isNull(pacaAutomations.deletedAt),
              lte(pacaAutomations.updatedAt, event.createdAt),
              eq(pacaAutomationNodes.kind, "trigger"),
              eq(pacaAutomationNodes.type, event.eventType),
            ),
          )
          .orderBy(asc(pacaAutomations.id), asc(pacaAutomationNodes.id));

        for (const { automation, trigger } of candidates) {
          if (!matchesTaskTrigger(event.eventType, event.payload, trigger)) continue;
          let runTaskId = event.taskId;
          if (event.eventType === "predecessor_done") {
            const eligible = event.payload.eligible_trigger_ids;
            if (!Array.isArray(eligible) || !eligible.every((id) => typeof id === "string")) {
              throw new Error("AUTOMATION_EVENT_PAYLOAD_INVALID");
            }
            if (!eligible.includes(trigger.id)) continue;
            const config = predecessorDoneTriggerConfigFromNode(trigger);
            const taskIds = [...new Set([...config.watched_task_ids, config.target_task_id])];
            const rows = await tx
              .select({ id: pacaTasks.id, category: pacaTaskStatuses.category })
              .from(pacaTasks)
              .leftJoin(
                pacaTaskStatuses,
                and(
                  eq(pacaTaskStatuses.id, pacaTasks.statusId),
                  eq(pacaTaskStatuses.projectId, event.projectId),
                ),
              )
              .where(
                and(
                  eq(pacaTasks.projectId, event.projectId),
                  inArray(pacaTasks.id, taskIds),
                  isNull(pacaTasks.deletedAt),
                ),
              );
            const byId = new Map(rows.map((row) => [row.id, row]));
            if (
              rows.length !== taskIds.length ||
              config.watched_task_ids.some((id) => byId.get(id)?.category !== "done")
            ) {
              continue;
            }
            runTaskId = config.target_task_id;
          }
          const [nodes, edges] = await Promise.all([
            tx
              .select()
              .from(pacaAutomationNodes)
              .where(eq(pacaAutomationNodes.automationId, automation.id))
              .orderBy(asc(pacaAutomationNodes.id)),
            tx
              .select()
              .from(pacaAutomationEdges)
              .where(eq(pacaAutomationEdges.automationId, automation.id))
              .orderBy(asc(pacaAutomationEdges.id)),
          ]);
          validateRunnableAutomationGraph(nodes, edges);
          const snapshot: AutomationRunSnapshot = {
            version: 1,
            projectId: event.projectId,
            event: {
              id: event.id,
              type: event.eventType,
              taskId: runTaskId,
              payload: event.payload,
            },
            nodes: nodes.map((node) => ({
              id: node.id,
              kind: node.kind,
              type: node.type,
              config: node.config,
            })),
            edges: edges.map((edge) => ({
              sourceNodeId: edge.sourceNodeId,
              sourceHandle: edge.sourceHandle,
              targetNodeId: edge.targetNodeId,
            })),
          };
          const eventKey = `${event.id}:${trigger.id}`;
          const [inserted] = await tx
            .insert(pacaAutomationRuns)
            .values({
              automationId: automation.id,
              triggerNodeId: trigger.id,
              taskId: runTaskId,
              eventKey,
              graphVersion: automation.graphVersion,
              graphSnapshot: snapshot,
            })
            .onConflictDoNothing({
              target: [pacaAutomationRuns.automationId, pacaAutomationRuns.eventKey],
            })
            .returning({ id: pacaAutomationRuns.id, status: pacaAutomationRuns.status });
          if (inserted?.status === "running") {
            runIds.add(inserted.id);
            continue;
          }
          const [existing] = await tx
            .select({ id: pacaAutomationRuns.id, status: pacaAutomationRuns.status })
            .from(pacaAutomationRuns)
            .where(
              and(
                eq(pacaAutomationRuns.automationId, automation.id),
                eq(pacaAutomationRuns.eventKey, eventKey),
              ),
            );
          if (!existing) throw new Error("AUTOMATION_RUN_INSERT_MISSING");
          if (existing.status === "running") runIds.add(existing.id);
        }
        return [...runIds];
      },
      { isolationLevel: "repeatable read" },
    );
  }
}
