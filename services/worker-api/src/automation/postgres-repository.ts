import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import type { PacaDatabase } from "../database";
import {
  pacaAutomationEdges,
  pacaAutomationNodes,
  pacaAutomationRunSteps,
  pacaAutomationRuns,
  pacaAutomations,
  pacaTasks,
} from "../db/schema";
import { AutomationExecutionError } from "./errors";
import {
  predecessorDoneTriggerConfigFromNode,
  validateRunnableAutomationGraph,
} from "./execution-plan";
import {
  type GraphNode,
  normalizeAutomationName,
  validateAutomationDescription,
  validateAutomationEdge,
  validateAutomationNode,
  validateOutgoingConditionHandles,
} from "./graph";

export type AutomationRow = typeof pacaAutomations.$inferSelect;
export type AutomationNodeRow = typeof pacaAutomationNodes.$inferSelect;
export type AutomationEdgeRow = typeof pacaAutomationEdges.$inferSelect;
export type AutomationRunRow = typeof pacaAutomationRuns.$inferSelect;
export type AutomationRunStepRow = typeof pacaAutomationRunSteps.$inferSelect;
export type AutomationGraphRows = {
  automation: AutomationRow;
  nodes: AutomationNodeRow[];
  edges: AutomationEdgeRow[];
};

export const automationRepositoryErrorCodes = {
  notFound: "AUTOMATION_NOT_FOUND",
  nodeNotFound: "AUTOMATION_NODE_NOT_FOUND",
  edgeNotFound: "AUTOMATION_EDGE_NOT_FOUND",
  nameTaken: "AUTOMATION_NAME_TAKEN",
  activeImmutable: "AUTOMATION_ACTIVE_GRAPH_IMMUTABLE",
} as const;

export class AutomationRepositoryError extends Error {
  constructor(
    readonly code: (typeof automationRepositoryErrorCodes)[keyof typeof automationRepositoryErrorCodes],
  ) {
    super(code);
    this.name = "AutomationRepositoryError";
  }
}

function postgresCode(error: unknown): string | null {
  let candidate: unknown = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!candidate || typeof candidate !== "object") return null;
    if ("code" in candidate && typeof candidate.code === "string") return candidate.code;
    candidate = "cause" in candidate ? candidate.cause : null;
  }
  return null;
}

function asGraphNode(row: AutomationNodeRow): GraphNode {
  return {
    id: row.id,
    automationId: row.automationId,
    kind: row.kind,
    type: row.type,
    config: row.config,
  };
}

function asGraphEdge(row: AutomationEdgeRow) {
  return {
    sourceNodeId: row.sourceNodeId,
    sourceHandle: row.sourceHandle,
    targetNodeId: row.targetNodeId,
  };
}

export class PostgresAutomationRepository {
  constructor(private readonly database: PacaDatabase) {}

  async list(projectId: string, status?: "active" | "inactive"): Promise<AutomationRow[]> {
    return this.database
      .select()
      .from(pacaAutomations)
      .where(
        and(
          eq(pacaAutomations.projectId, projectId),
          isNull(pacaAutomations.deletedAt),
          status ? eq(pacaAutomations.status, status) : undefined,
        ),
      )
      .orderBy(desc(pacaAutomations.updatedAt), asc(pacaAutomations.name));
  }

  async create(input: {
    projectId: string;
    actorUserId: string;
    name: string;
    description?: string;
  }): Promise<AutomationRow> {
    const name = normalizeAutomationName(input.name);
    const description = validateAutomationDescription(input.description ?? "");
    try {
      const [created] = await this.database
        .insert(pacaAutomations)
        .values({ projectId: input.projectId, createdBy: input.actorUserId, name, description })
        .returning();
      if (!created) throw new Error("AUTOMATION_CREATE_EMPTY_RESULT");
      return created;
    } catch (error) {
      if (postgresCode(error) === "23505") {
        throw new AutomationRepositoryError(automationRepositoryErrorCodes.nameTaken);
      }
      throw error;
    }
  }

  async getGraph(projectId: string, automationId: string): Promise<AutomationGraphRows> {
    return this.database.transaction(
      async (tx) => {
        const [automation] = await tx
          .select()
          .from(pacaAutomations)
          .where(
            and(
              eq(pacaAutomations.id, automationId),
              eq(pacaAutomations.projectId, projectId),
              isNull(pacaAutomations.deletedAt),
            ),
          );
        if (!automation)
          throw new AutomationRepositoryError(automationRepositoryErrorCodes.notFound);
        const [nodes, edges] = await Promise.all([
          tx
            .select()
            .from(pacaAutomationNodes)
            .where(eq(pacaAutomationNodes.automationId, automationId))
            .orderBy(asc(pacaAutomationNodes.createdAt), asc(pacaAutomationNodes.id)),
          tx
            .select()
            .from(pacaAutomationEdges)
            .where(eq(pacaAutomationEdges.automationId, automationId))
            .orderBy(asc(pacaAutomationEdges.createdAt), asc(pacaAutomationEdges.id)),
        ]);
        return { automation, nodes, edges };
      },
      { isolationLevel: "repeatable read" },
    );
  }

  async listRuns(
    projectId: string,
    automationId: string,
    limit: number,
  ): Promise<AutomationRunRow[]> {
    const [automation] = await this.database
      .select({ id: pacaAutomations.id })
      .from(pacaAutomations)
      .where(
        and(
          eq(pacaAutomations.id, automationId),
          eq(pacaAutomations.projectId, projectId),
          isNull(pacaAutomations.deletedAt),
        ),
      );
    if (!automation) throw new AutomationRepositoryError(automationRepositoryErrorCodes.notFound);
    return this.database
      .select()
      .from(pacaAutomationRuns)
      .where(eq(pacaAutomationRuns.automationId, automationId))
      .orderBy(desc(pacaAutomationRuns.startedAt), desc(pacaAutomationRuns.id))
      .limit(limit);
  }

  async listRunSteps(
    projectId: string,
    automationId: string,
    runId: string,
  ): Promise<AutomationRunStepRow[]> {
    const [run] = await this.database
      .select({ id: pacaAutomationRuns.id })
      .from(pacaAutomationRuns)
      .innerJoin(pacaAutomations, eq(pacaAutomationRuns.automationId, pacaAutomations.id))
      .where(
        and(
          eq(pacaAutomationRuns.id, runId),
          eq(pacaAutomations.id, automationId),
          eq(pacaAutomations.projectId, projectId),
          isNull(pacaAutomations.deletedAt),
        ),
      );
    if (!run) throw new AutomationRepositoryError(automationRepositoryErrorCodes.notFound);
    return this.database
      .select()
      .from(pacaAutomationRunSteps)
      .where(eq(pacaAutomationRunSteps.runId, runId))
      .orderBy(asc(pacaAutomationRunSteps.executedAt), asc(pacaAutomationRunSteps.id));
  }

  async update(
    projectId: string,
    automationId: string,
    input: { name?: string; description?: string },
  ): Promise<AutomationRow> {
    const name = input.name === undefined ? undefined : normalizeAutomationName(input.name);
    const description =
      input.description === undefined
        ? undefined
        : validateAutomationDescription(input.description);
    try {
      return await this.database.transaction(async (tx) => {
        const [automation] = await tx
          .select()
          .from(pacaAutomations)
          .where(
            and(
              eq(pacaAutomations.id, automationId),
              eq(pacaAutomations.projectId, projectId),
              isNull(pacaAutomations.deletedAt),
            ),
          )
          .for("update");
        if (!automation)
          throw new AutomationRepositoryError(automationRepositoryErrorCodes.notFound);
        if (automation.status === "active") {
          throw new AutomationRepositoryError(automationRepositoryErrorCodes.activeImmutable);
        }
        const [updated] = await tx
          .update(pacaAutomations)
          .set({ name, description, updatedAt: new Date() })
          .where(eq(pacaAutomations.id, automationId))
          .returning();
        if (!updated) throw new Error("AUTOMATION_UPDATE_MISSING");
        return updated;
      });
    } catch (error) {
      if (postgresCode(error) === "23505") {
        throw new AutomationRepositoryError(automationRepositoryErrorCodes.nameTaken);
      }
      throw error;
    }
  }

  async setActive(
    projectId: string,
    automationId: string,
    active: boolean,
  ): Promise<AutomationRow> {
    return this.database.transaction(async (tx) => {
      const [automation] = await tx
        .select()
        .from(pacaAutomations)
        .where(
          and(
            eq(pacaAutomations.id, automationId),
            eq(pacaAutomations.projectId, projectId),
            isNull(pacaAutomations.deletedAt),
          ),
        )
        .for("update");
      if (!automation) throw new AutomationRepositoryError(automationRepositoryErrorCodes.notFound);
      const nextStatus = active ? "active" : "inactive";
      if (automation.status === nextStatus) return automation;
      if (active) {
        const [nodes, edges] = await Promise.all([
          tx
            .select()
            .from(pacaAutomationNodes)
            .where(eq(pacaAutomationNodes.automationId, automationId)),
          tx
            .select()
            .from(pacaAutomationEdges)
            .where(eq(pacaAutomationEdges.automationId, automationId)),
        ]);
        validateRunnableAutomationGraph(nodes, edges);
        const predecessorTaskIds = new Set<string>();
        for (const node of nodes) {
          if (node.kind !== "trigger" || node.type !== "predecessor_done") continue;
          const config = predecessorDoneTriggerConfigFromNode(node);
          predecessorTaskIds.add(config.target_task_id);
          for (const id of config.watched_task_ids) predecessorTaskIds.add(id);
        }
        if (predecessorTaskIds.size > 0) {
          const rows = await tx
            .select({ id: pacaTasks.id })
            .from(pacaTasks)
            .where(
              and(
                eq(pacaTasks.projectId, projectId),
                inArray(pacaTasks.id, [...predecessorTaskIds]),
                isNull(pacaTasks.deletedAt),
              ),
            );
          if (rows.length !== predecessorTaskIds.size) {
            throw new AutomationExecutionError("AUTOMATION_TRIGGER_TASK_NOT_FOUND");
          }
        }
      }
      const [updated] = await tx
        .update(pacaAutomations)
        .set({ status: nextStatus, updatedAt: new Date() })
        .where(eq(pacaAutomations.id, automationId))
        .returning();
      if (!updated) throw new Error("AUTOMATION_STATUS_UPDATE_MISSING");
      return updated;
    });
  }

  async archive(projectId: string, automationId: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      const [automation] = await tx
        .select({ status: pacaAutomations.status })
        .from(pacaAutomations)
        .where(
          and(
            eq(pacaAutomations.id, automationId),
            eq(pacaAutomations.projectId, projectId),
            isNull(pacaAutomations.deletedAt),
          ),
        )
        .for("update");
      if (!automation) throw new AutomationRepositoryError(automationRepositoryErrorCodes.notFound);
      if (automation.status === "active") {
        throw new AutomationRepositoryError(automationRepositoryErrorCodes.activeImmutable);
      }
      await tx
        .update(pacaAutomations)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(pacaAutomations.id, automationId));
    });
  }

  async addNode(
    projectId: string,
    automationId: string,
    input: { kind: string; type: string; config: unknown; posX: number; posY: number },
  ): Promise<AutomationNodeRow> {
    validateAutomationNode(input);
    return this.database.transaction(async (tx) => {
      const [automation] = await tx
        .select({ id: pacaAutomations.id, status: pacaAutomations.status })
        .from(pacaAutomations)
        .where(
          and(
            eq(pacaAutomations.id, automationId),
            eq(pacaAutomations.projectId, projectId),
            isNull(pacaAutomations.deletedAt),
          ),
        )
        .for("update");
      if (!automation) throw new AutomationRepositoryError(automationRepositoryErrorCodes.notFound);
      if (automation.status === "active") {
        throw new AutomationRepositoryError(automationRepositoryErrorCodes.activeImmutable);
      }
      const [node] = await tx
        .insert(pacaAutomationNodes)
        .values({ automationId, ...input })
        .returning();
      if (!node) throw new Error("AUTOMATION_NODE_INSERT_EMPTY_RESULT");
      await tx
        .update(pacaAutomations)
        .set({ graphVersion: sql`${pacaAutomations.graphVersion} + 1`, updatedAt: new Date() })
        .where(eq(pacaAutomations.id, automationId));
      return node;
    });
  }

  async removeNode(projectId: string, automationId: string, nodeId: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      const [automation] = await tx
        .select({ id: pacaAutomations.id, status: pacaAutomations.status })
        .from(pacaAutomations)
        .where(
          and(
            eq(pacaAutomations.id, automationId),
            eq(pacaAutomations.projectId, projectId),
            isNull(pacaAutomations.deletedAt),
          ),
        )
        .for("update");
      if (!automation) throw new AutomationRepositoryError(automationRepositoryErrorCodes.notFound);
      if (automation.status === "active") {
        throw new AutomationRepositoryError(automationRepositoryErrorCodes.activeImmutable);
      }
      const [removed] = await tx
        .delete(pacaAutomationNodes)
        .where(
          and(
            eq(pacaAutomationNodes.id, nodeId),
            eq(pacaAutomationNodes.automationId, automationId),
          ),
        )
        .returning({ id: pacaAutomationNodes.id });
      if (!removed)
        throw new AutomationRepositoryError(automationRepositoryErrorCodes.nodeNotFound);
      await tx
        .update(pacaAutomations)
        .set({ graphVersion: sql`${pacaAutomations.graphVersion} + 1`, updatedAt: new Date() })
        .where(eq(pacaAutomations.id, automationId));
    });
  }

  async updateNode(
    projectId: string,
    automationId: string,
    nodeId: string,
    input: { config?: unknown; posX?: number; posY?: number },
  ): Promise<AutomationNodeRow> {
    return this.database.transaction(async (tx) => {
      const [automation] = await tx
        .select({ id: pacaAutomations.id, status: pacaAutomations.status })
        .from(pacaAutomations)
        .where(
          and(
            eq(pacaAutomations.id, automationId),
            eq(pacaAutomations.projectId, projectId),
            isNull(pacaAutomations.deletedAt),
          ),
        )
        .for("update");
      if (!automation) throw new AutomationRepositoryError(automationRepositoryErrorCodes.notFound);
      if (automation.status === "active") {
        throw new AutomationRepositoryError(automationRepositoryErrorCodes.activeImmutable);
      }
      const [existing] = await tx
        .select()
        .from(pacaAutomationNodes)
        .where(
          and(
            eq(pacaAutomationNodes.id, nodeId),
            eq(pacaAutomationNodes.automationId, automationId),
          ),
        );
      if (!existing)
        throw new AutomationRepositoryError(automationRepositoryErrorCodes.nodeNotFound);
      const candidate = {
        kind: existing.kind,
        type: existing.type,
        config: input.config === undefined ? existing.config : input.config,
        posX: input.posX ?? existing.posX,
        posY: input.posY ?? existing.posY,
      };
      validateAutomationNode(candidate);
      if (existing.kind === "condition" && input.config !== undefined) {
        const outgoing = await tx
          .select()
          .from(pacaAutomationEdges)
          .where(eq(pacaAutomationEdges.sourceNodeId, nodeId));
        validateOutgoingConditionHandles(
          { ...asGraphNode(existing), config: candidate.config },
          outgoing.map(asGraphEdge),
        );
      }
      const [updated] = await tx
        .update(pacaAutomationNodes)
        .set({
          config: candidate.config,
          posX: candidate.posX,
          posY: candidate.posY,
          updatedAt: new Date(),
        })
        .where(eq(pacaAutomationNodes.id, nodeId))
        .returning();
      if (!updated) throw new Error("AUTOMATION_NODE_UPDATE_EMPTY_RESULT");
      await tx
        .update(pacaAutomations)
        .set({ graphVersion: sql`${pacaAutomations.graphVersion} + 1`, updatedAt: new Date() })
        .where(eq(pacaAutomations.id, automationId));
      return updated;
    });
  }

  async addEdge(
    projectId: string,
    automationId: string,
    input: { sourceNodeId: string; sourceHandle?: string | null; targetNodeId: string },
  ): Promise<AutomationEdgeRow> {
    return this.database.transaction(async (tx) => {
      // The parent row lock serializes graph edits across requests. Without it,
      // two concurrent edge inserts could each observe an acyclic graph.
      const [automation] = await tx
        .select({ id: pacaAutomations.id, status: pacaAutomations.status })
        .from(pacaAutomations)
        .where(
          and(
            eq(pacaAutomations.id, automationId),
            eq(pacaAutomations.projectId, projectId),
            isNull(pacaAutomations.deletedAt),
          ),
        )
        .for("update");
      if (!automation) throw new AutomationRepositoryError(automationRepositoryErrorCodes.notFound);
      if (automation.status === "active") {
        throw new AutomationRepositoryError(automationRepositoryErrorCodes.activeImmutable);
      }
      const [nodes, edges] = await Promise.all([
        tx
          .select()
          .from(pacaAutomationNodes)
          .where(eq(pacaAutomationNodes.automationId, automationId)),
        tx
          .select()
          .from(pacaAutomationEdges)
          .where(eq(pacaAutomationEdges.automationId, automationId)),
      ]);
      const candidate = {
        sourceNodeId: input.sourceNodeId,
        sourceHandle: input.sourceHandle ?? null,
        targetNodeId: input.targetNodeId,
      };
      validateAutomationEdge(nodes.map(asGraphNode), edges.map(asGraphEdge), candidate);
      const [edge] = await tx
        .insert(pacaAutomationEdges)
        .values({ automationId, ...candidate })
        .returning();
      if (!edge) throw new Error("AUTOMATION_EDGE_INSERT_EMPTY_RESULT");
      await tx
        .update(pacaAutomations)
        .set({ graphVersion: sql`${pacaAutomations.graphVersion} + 1`, updatedAt: new Date() })
        .where(eq(pacaAutomations.id, automationId));
      return edge;
    });
  }

  async removeEdge(projectId: string, automationId: string, edgeId: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      const [automation] = await tx
        .select({ id: pacaAutomations.id, status: pacaAutomations.status })
        .from(pacaAutomations)
        .where(
          and(
            eq(pacaAutomations.id, automationId),
            eq(pacaAutomations.projectId, projectId),
            isNull(pacaAutomations.deletedAt),
          ),
        )
        .for("update");
      if (!automation) throw new AutomationRepositoryError(automationRepositoryErrorCodes.notFound);
      if (automation.status === "active") {
        throw new AutomationRepositoryError(automationRepositoryErrorCodes.activeImmutable);
      }
      const [removed] = await tx
        .delete(pacaAutomationEdges)
        .where(
          and(
            eq(pacaAutomationEdges.id, edgeId),
            eq(pacaAutomationEdges.automationId, automationId),
          ),
        )
        .returning({ id: pacaAutomationEdges.id });
      if (!removed)
        throw new AutomationRepositoryError(automationRepositoryErrorCodes.edgeNotFound);
      await tx
        .update(pacaAutomations)
        .set({ graphVersion: sql`${pacaAutomations.graphVersion} + 1`, updatedAt: new Date() })
        .where(eq(pacaAutomations.id, automationId));
    });
  }
}
