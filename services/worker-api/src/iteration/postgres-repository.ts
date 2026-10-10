import { and, asc, eq, inArray, isNull, max, sql } from "drizzle-orm";
import type { PacaDatabase } from "../database";
import {
  pacaProjects,
  pacaSprints,
  pacaTaskActivities,
  pacaTaskStatuses,
  pacaTasks,
  pacaTaskViews,
  pacaViewTaskPositions,
} from "../db/schema";
import type { TaskActor } from "../task/service";
import {
  IterationError,
  type IterationRepository,
  iterationErrorCodes,
  normalizeSprintUpdate,
  type PersistedSprintCreate,
  type PersistedViewCreate,
  type Sprint,
  type SprintStatus,
  type SprintUpdateInput,
  type TaskPositionInput,
  type TaskView,
  type ViewContext,
  type ViewTaskPosition,
  type ViewType,
  type ViewUpdateInput,
} from "./service";

export function sprintFromRow(row: typeof pacaSprints.$inferSelect): Sprint {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    startDate: row.startDate,
    endDate: row.endDate,
    goal: row.goal,
    status: row.status as SprintStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function viewFromRow(row: typeof pacaTaskViews.$inferSelect): TaskView {
  return {
    id: row.id,
    sprintId: row.sprintId,
    projectId: row.projectId,
    name: row.name,
    viewType: row.viewType as ViewType,
    viewContext: row.viewContext as ViewContext,
    config: row.config,
    position: row.position,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function defaultSprintViews(input: PersistedSprintCreate) {
  const filter = {
    task_types: { all: false, items: { normal: { all: true } } },
    sprints: { all: false, items: { [input.id]: true } },
  };
  return [
    {
      id: crypto.randomUUID(),
      sprintId: input.id,
      projectId: input.projectId,
      name: "Board",
      viewType: "board",
      viewContext: "sprint",
      config: { column_by: "status", filters: filter },
      position: 0,
    },
    {
      id: crypto.randomUUID(),
      sprintId: input.id,
      projectId: input.projectId,
      name: "Table",
      viewType: "table",
      viewContext: "sprint",
      config: { column_by: "status", filters: filter },
      position: 1,
    },
  ];
}

export class PostgresIterationRepository implements IterationRepository {
  constructor(private readonly database: PacaDatabase) {}

  async listSprints(projectId: string): Promise<Sprint[]> {
    const rows = await this.database
      .select()
      .from(pacaSprints)
      .where(eq(pacaSprints.projectId, projectId))
      .orderBy(asc(pacaSprints.createdAt), asc(pacaSprints.id));
    return rows.map(sprintFromRow);
  }

  async findSprint(projectId: string, sprintId: string): Promise<Sprint> {
    const [row] = await this.database
      .select()
      .from(pacaSprints)
      .where(and(eq(pacaSprints.id, sprintId), eq(pacaSprints.projectId, projectId)))
      .limit(1);
    if (!row) throw new IterationError(iterationErrorCodes.sprintNotFound);
    return sprintFromRow(row);
  }

  async createSprint(input: PersistedSprintCreate): Promise<Sprint> {
    return this.database.transaction(async (transaction) => {
      const [project] = await transaction
        .select({ id: pacaProjects.id })
        .from(pacaProjects)
        .where(and(eq(pacaProjects.id, input.projectId), eq(pacaProjects.status, "active")))
        .limit(1);
      if (!project) throw new IterationError(iterationErrorCodes.sprintNotFound);
      const [row] = await transaction.insert(pacaSprints).values(input).returning();
      if (!row) throw new Error("SPRINT_CREATE_FAILED");
      await transaction.insert(pacaTaskViews).values(defaultSprintViews(input));
      return sprintFromRow(row);
    });
  }

  async updateSprint(
    projectId: string,
    sprintId: string,
    input: SprintUpdateInput,
  ): Promise<Sprint> {
    return this.database.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(pacaSprints)
        .where(and(eq(pacaSprints.id, sprintId), eq(pacaSprints.projectId, projectId)))
        .for("update");
      if (!current) throw new IterationError(iterationErrorCodes.sprintNotFound);
      const normalized = normalizeSprintUpdate(sprintFromRow(current), input);
      const changed = Object.entries(normalized).some(
        ([key, value]) => current[key as keyof typeof normalized] !== value,
      );
      if (!changed) return sprintFromRow(current);
      const [row] = await tx
        .update(pacaSprints)
        .set({ ...normalized, updatedAt: new Date() })
        .where(eq(pacaSprints.id, sprintId))
        .returning();
      if (!row) throw new IterationError(iterationErrorCodes.sprintNotFound);
      return sprintFromRow(row);
    });
  }

  async deleteSprint(projectId: string, sprintId: string, actorUserId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const [sprint] = await transaction
        .select({ id: pacaSprints.id })
        .from(pacaSprints)
        .where(and(eq(pacaSprints.id, sprintId), eq(pacaSprints.projectId, projectId)))
        .for("update")
        .limit(1);
      if (!sprint) throw new IterationError(iterationErrorCodes.sprintNotFound);
      const movedTasks = await transaction
        .update(pacaTasks)
        .set({ sprintId: null, updatedAt: new Date() })
        .where(and(eq(pacaTasks.projectId, projectId), eq(pacaTasks.sprintId, sprintId)))
        .returning({ id: pacaTasks.id });
      if (movedTasks.length > 0) {
        await transaction.insert(pacaTaskActivities).values(
          movedTasks.map((task) => ({
            id: crypto.randomUUID(),
            taskId: task.id,
            projectId,
            actorType: "user",
            actorId: actorUserId,
            actorUserId,
            actorAgentId: null,
            activityType: "task.updated",
            content: { changes: [{ field: "sprint", old: sprintId, new: null }] },
          })),
        );
      }
      await transaction
        .delete(pacaSprints)
        .where(and(eq(pacaSprints.id, sprintId), eq(pacaSprints.projectId, projectId)));
    });
  }

  async completeSprint(
    projectId: string,
    sprintId: string,
    destinationSprintId: string | null,
    actorUserId: string,
  ): Promise<Sprint> {
    return this.database.transaction(async (transaction) => {
      const result = await completeSprintInTransaction(
        transaction,
        projectId,
        sprintId,
        destinationSprintId,
        { type: "user", id: actorUserId },
      );
      return result.updated;
    });
  }

  async listViews(
    projectId: string,
    context: ViewContext,
    sprintId: string | null,
  ): Promise<TaskView[]> {
    if (sprintId !== null) {
      const [sprint] = await this.database
        .select({ id: pacaSprints.id })
        .from(pacaSprints)
        .where(and(eq(pacaSprints.id, sprintId), eq(pacaSprints.projectId, projectId)))
        .limit(1);
      if (!sprint) throw new IterationError(iterationErrorCodes.sprintNotFound);
    }
    const rows = await this.database
      .select()
      .from(pacaTaskViews)
      .where(
        and(
          eq(pacaTaskViews.projectId, projectId),
          eq(pacaTaskViews.viewContext, context),
          sprintId === null ? isNull(pacaTaskViews.sprintId) : eq(pacaTaskViews.sprintId, sprintId),
        ),
      )
      .orderBy(asc(pacaTaskViews.position), asc(pacaTaskViews.createdAt));
    return rows.map(viewFromRow);
  }

  async findView(projectId: string, viewId: string): Promise<TaskView> {
    const [row] = await this.database
      .select()
      .from(pacaTaskViews)
      .where(and(eq(pacaTaskViews.id, viewId), eq(pacaTaskViews.projectId, projectId)))
      .limit(1);
    if (!row) throw new IterationError(iterationErrorCodes.viewNotFound);
    return viewFromRow(row);
  }

  async createView(input: PersistedViewCreate): Promise<TaskView> {
    return this.database.transaction(async (transaction) => {
      if (input.sprintId !== null) {
        const [sprint] = await transaction
          .select({ id: pacaSprints.id })
          .from(pacaSprints)
          .where(
            and(eq(pacaSprints.id, input.sprintId), eq(pacaSprints.projectId, input.projectId)),
          )
          .limit(1);
        if (!sprint) throw new IterationError(iterationErrorCodes.sprintNotFound);
      } else {
        const [project] = await transaction
          .select({ id: pacaProjects.id })
          .from(pacaProjects)
          .where(and(eq(pacaProjects.id, input.projectId), eq(pacaProjects.status, "active")))
          .limit(1);
        if (!project) throw new IterationError(iterationErrorCodes.viewNotFound);
      }
      let position = input.position;
      if (position === null) {
        const [row] = await transaction
          .select({ value: max(pacaTaskViews.position) })
          .from(pacaTaskViews)
          .where(
            and(
              eq(pacaTaskViews.projectId, input.projectId),
              eq(pacaTaskViews.viewContext, input.viewContext),
              input.sprintId === null
                ? isNull(pacaTaskViews.sprintId)
                : eq(pacaTaskViews.sprintId, input.sprintId),
            ),
          );
        position = Number(row?.value ?? -1) + 1;
      }
      const [row] = await transaction
        .insert(pacaTaskViews)
        .values({ ...input, position })
        .returning();
      if (!row) throw new Error("VIEW_CREATE_FAILED");
      return viewFromRow(row);
    });
  }

  async updateView(projectId: string, viewId: string, input: ViewUpdateInput): Promise<TaskView> {
    const [row] = await this.database
      .update(pacaTaskViews)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(pacaTaskViews.id, viewId), eq(pacaTaskViews.projectId, projectId)))
      .returning();
    if (!row) throw new IterationError(iterationErrorCodes.viewNotFound);
    return viewFromRow(row);
  }

  async deleteView(projectId: string, viewId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const [view] = await transaction
        .select()
        .from(pacaTaskViews)
        .where(and(eq(pacaTaskViews.id, viewId), eq(pacaTaskViews.projectId, projectId)))
        .limit(1);
      if (!view) throw new IterationError(iterationErrorCodes.viewNotFound);
      const rows = await transaction
        .select({ id: pacaTaskViews.id })
        .from(pacaTaskViews)
        .where(
          and(
            eq(pacaTaskViews.projectId, projectId),
            eq(pacaTaskViews.viewContext, view.viewContext),
            view.sprintId === null
              ? isNull(pacaTaskViews.sprintId)
              : eq(pacaTaskViews.sprintId, view.sprintId),
          ),
        )
        .for("update");
      if (rows.length <= 1) {
        throw new IterationError(iterationErrorCodes.viewIsLast);
      }
      await transaction
        .delete(pacaTaskViews)
        .where(and(eq(pacaTaskViews.id, viewId), eq(pacaTaskViews.projectId, projectId)));
    });
  }

  async reorderViews(
    projectId: string,
    context: ViewContext,
    sprintId: string | null,
    viewIds: string[],
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({ id: pacaTaskViews.id })
        .from(pacaTaskViews)
        .where(
          and(
            eq(pacaTaskViews.projectId, projectId),
            eq(pacaTaskViews.viewContext, context),
            sprintId === null
              ? isNull(pacaTaskViews.sprintId)
              : eq(pacaTaskViews.sprintId, sprintId),
          ),
        )
        .for("update");
      const existing = rows.map((row) => row.id).sort();
      const desired = [...viewIds].sort();
      if (
        existing.length !== desired.length ||
        existing.some((id, index) => id !== desired[index])
      ) {
        throw new IterationError(iterationErrorCodes.viewReorderInvalid);
      }
      for (const [position, id] of viewIds.entries()) {
        await transaction
          .update(pacaTaskViews)
          .set({ position, updatedAt: new Date() })
          .where(and(eq(pacaTaskViews.id, id), eq(pacaTaskViews.projectId, projectId)));
      }
    });
  }

  async listTaskPositions(projectId: string, viewId: string): Promise<ViewTaskPosition[]> {
    await this.findView(projectId, viewId);
    const rows = await this.database
      .select()
      .from(pacaViewTaskPositions)
      .where(
        and(
          eq(pacaViewTaskPositions.viewId, viewId),
          eq(pacaViewTaskPositions.projectId, projectId),
        ),
      )
      .orderBy(asc(pacaViewTaskPositions.position), asc(pacaViewTaskPositions.taskId));
    return rows.map((row) => ({
      id: row.id,
      viewId: row.viewId,
      taskId: row.taskId,
      position: row.position,
      groupKey: row.groupKey,
    }));
  }

  async upsertTaskPositions(
    projectId: string,
    viewId: string,
    items: TaskPositionInput[],
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const [view] = await transaction
        .select({ id: pacaTaskViews.id })
        .from(pacaTaskViews)
        .where(and(eq(pacaTaskViews.id, viewId), eq(pacaTaskViews.projectId, projectId)))
        .limit(1);
      if (!view) throw new IterationError(iterationErrorCodes.viewNotFound);
      const taskIds = items.map((item) => item.taskId);
      const tasks = await transaction
        .select({ id: pacaTasks.id })
        .from(pacaTasks)
        .where(
          and(
            eq(pacaTasks.projectId, projectId),
            inArray(pacaTasks.id, taskIds),
            isNull(pacaTasks.deletedAt),
          ),
        );
      if (tasks.length !== taskIds.length) {
        throw new IterationError(iterationErrorCodes.taskPositionInvalid);
      }
      await transaction
        .insert(pacaViewTaskPositions)
        .values(
          items.map((item) => ({
            id: crypto.randomUUID(),
            viewId,
            taskId: item.taskId,
            projectId,
            position: item.position,
            groupKey: item.groupKey ?? null,
          })),
        )
        .onConflictDoUpdate({
          target: [pacaViewTaskPositions.viewId, pacaViewTaskPositions.taskId],
          set: {
            position: sql`excluded.position`,
            groupKey: sql`excluded.group_key`,
          },
        });
    });
  }
}

export type SprintWriteDatabase = Pick<
  PacaDatabase,
  "select" | "update" | "insert" | "$with" | "with"
>;
export async function completeSprintInTransaction(
  transaction: SprintWriteDatabase,
  projectId: string,
  sprintId: string,
  destinationSprintId: string | null,
  actor: TaskActor,
  allowCompleted = false,
): Promise<{ before: Sprint; updated: Sprint; movedTasks: number; applied: boolean }> {
  if (destinationSprintId === sprintId)
    throw new IterationError(iterationErrorCodes.destinationInvalid);
  const rows = await transaction
    .select()
    .from(pacaSprints)
    .where(
      and(
        eq(pacaSprints.projectId, projectId),
        inArray(pacaSprints.id, destinationSprintId ? [sprintId, destinationSprintId] : [sprintId]),
      ),
    )
    .orderBy(asc(pacaSprints.id))
    .for("update");
  const source = rows.find((row) => row.id === sprintId);
  if (!source) throw new IterationError(iterationErrorCodes.sprintNotFound);
  const before = sprintFromRow(source);
  if (source.status === "completed") {
    if (!allowCompleted) throw new IterationError(iterationErrorCodes.sprintAlreadyCompleted);
    return { before, updated: before, movedTasks: 0, applied: false };
  }
  if (
    destinationSprintId &&
    !rows.some((row) => row.id === destinationSprintId && row.status !== "completed")
  )
    throw new IterationError(iterationErrorCodes.destinationInvalid);
  // A data-modifying CTE keeps the bulk move and per-task audit on the database,
  // instead of bringing an unbounded task ID list into Worker memory.
  const moved = transaction.$with("moved_sprint_tasks").as(
    transaction
      .update(pacaTasks)
      .set({ sprintId: destinationSprintId, updatedAt: new Date() })
      .where(
        and(
          eq(pacaTasks.projectId, projectId),
          eq(pacaTasks.sprintId, sprintId),
          isNull(pacaTasks.deletedAt),
          sql`not exists (select 1 from ${pacaTaskStatuses} where ${pacaTaskStatuses.id} = ${pacaTasks.statusId} and ${pacaTaskStatuses.projectId} = ${projectId} and ${pacaTaskStatuses.category} = 'done')`,
        ),
      )
      .returning({ id: pacaTasks.id }),
  );
  const content: Record<string, unknown> = {
    changes: [{ field: "sprint", old: sprintId, new: destinationSprintId }],
    ...(actor.type === "system" ? { automation_run_id: actor.runId } : {}),
  };
  const result = await transaction
    .with(moved)
    .insert(pacaTaskActivities)
    .select(
      transaction
        .select({
          id: sql<string>`gen_random_uuid()`.as("id"),
          taskId: moved.id,
          projectId: sql<string>`${projectId}::uuid`.as("projectId"),
          actorType: sql<string>`${actor.type}`.as("actorType"),
          actorId: sql<string>`${actor.id}`.as("actorId"),
          actorUserId: sql<string | null>`${actor.type === "user" ? actor.id : null}`.as(
            "actorUserId",
          ),
          actorAgentId: sql<string | null>`${actor.type === "agent" ? actor.id : null}`.as(
            "actorAgentId",
          ),
          actorMemberId: sql<string | null>`null::uuid`.as("actorMemberId"),
          activityType: sql<string>`'task.updated'`.as("activityType"),
          content: sql<Record<string, unknown>>`${JSON.stringify(content)}::jsonb`.as("content"),
        })
        .from(moved),
    );
  const [updated] = await transaction
    .update(pacaSprints)
    .set({ status: "completed", updatedAt: new Date() })
    .where(eq(pacaSprints.id, sprintId))
    .returning();
  if (!updated) throw new IterationError(iterationErrorCodes.sprintNotFound);
  return {
    before,
    updated: sprintFromRow(updated),
    movedTasks: result.rowCount ?? 0,
    applied: true,
  };
}
