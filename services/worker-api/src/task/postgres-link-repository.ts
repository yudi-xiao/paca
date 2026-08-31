import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { PacaDatabase } from "../database";
import { pacaProjectMembers, pacaTaskActivities, pacaTaskLinks, pacaTasks } from "../db/schema";
import {
  type DisplayLinkType,
  type LinkType,
  type TaskLink,
  type TaskLinkCreateInput,
  TaskLinkError,
  type TaskLinkRepository,
  taskLinkErrorCodes,
} from "./link-service";
import { TaskError, taskErrorCodes } from "./service";

const linkedTask = alias(pacaTasks, "linked_task");

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function displayType(linkType: LinkType, queriedTaskIsSource: boolean): DisplayLinkType {
  if (queriedTaskIsSource || linkType === "relates_to") return linkType;
  return linkType === "blocks" ? "is_blocked_by" : "is_duplicated_by";
}

export class PostgresTaskLinkRepository implements TaskLinkRepository {
  constructor(private readonly database: PacaDatabase) {}

  async list(projectId: string, taskId: string): Promise<TaskLink[]> {
    await this.requireTask(projectId, taskId);
    const rows = await this.database
      .select({
        id: pacaTaskLinks.id,
        projectId: pacaTaskLinks.projectId,
        sourceTaskId: pacaTaskLinks.sourceTaskId,
        targetTaskId: pacaTaskLinks.targetTaskId,
        linkType: pacaTaskLinks.linkType,
        createdBy: pacaTaskLinks.createdBy,
        createdAt: pacaTaskLinks.createdAt,
        linkedTaskId: linkedTask.id,
        linkedTaskNumber: linkedTask.taskNumber,
        linkedTaskTitle: linkedTask.title,
        linkedTaskStatusId: linkedTask.statusId,
        linkedTaskTypeId: linkedTask.taskTypeId,
      })
      .from(pacaTaskLinks)
      .innerJoin(
        linkedTask,
        or(
          and(
            eq(pacaTaskLinks.sourceTaskId, taskId),
            eq(linkedTask.id, pacaTaskLinks.targetTaskId),
          ),
          and(
            eq(pacaTaskLinks.targetTaskId, taskId),
            eq(linkedTask.id, pacaTaskLinks.sourceTaskId),
          ),
        ),
      )
      .where(
        and(
          eq(pacaTaskLinks.projectId, projectId),
          or(eq(pacaTaskLinks.sourceTaskId, taskId), eq(pacaTaskLinks.targetTaskId, taskId)),
          isNull(linkedTask.deletedAt),
        ),
      )
      .orderBy(asc(pacaTaskLinks.createdAt), asc(pacaTaskLinks.id));

    return rows.map((row) => {
      const linkType = row.linkType as LinkType;
      return {
        id: row.id,
        projectId: row.projectId,
        sourceTaskId: row.sourceTaskId,
        targetTaskId: row.targetTaskId,
        linkType,
        displayLinkType: displayType(linkType, row.sourceTaskId === taskId),
        linkedTask: {
          id: row.linkedTaskId,
          taskNumber: row.linkedTaskNumber,
          title: row.linkedTaskTitle,
          statusId: row.linkedTaskStatusId,
          taskTypeId: row.linkedTaskTypeId,
        },
        createdBy: row.createdBy,
        createdAt: row.createdAt,
      };
    });
  }

  async create(input: TaskLinkCreateInput): Promise<TaskLink> {
    try {
      return await this.database.transaction(async (transaction) => {
        const taskIds = [input.sourceTaskId, input.targetTaskId].sort();
        const tasks = await transaction
          .select({
            id: pacaTasks.id,
            projectId: pacaTasks.projectId,
            taskNumber: pacaTasks.taskNumber,
            title: pacaTasks.title,
            statusId: pacaTasks.statusId,
            taskTypeId: pacaTasks.taskTypeId,
          })
          .from(pacaTasks)
          .where(and(inArray(pacaTasks.id, taskIds), isNull(pacaTasks.deletedAt)))
          .orderBy(asc(pacaTasks.id))
          .for("update");
        const source = tasks.find((task) => task.id === input.sourceTaskId);
        if (!source || source.projectId !== input.projectId) {
          throw new TaskError(taskErrorCodes.notFound);
        }
        const target = tasks.find((task) => task.id === input.targetTaskId);
        if (!target) throw new TaskError(taskErrorCodes.notFound);
        if (target.projectId !== input.projectId) {
          throw new TaskLinkError(taskLinkErrorCodes.crossProject);
        }

        const direction =
          input.linkType === "relates_to"
            ? or(
                and(
                  eq(pacaTaskLinks.sourceTaskId, input.sourceTaskId),
                  eq(pacaTaskLinks.targetTaskId, input.targetTaskId),
                ),
                and(
                  eq(pacaTaskLinks.sourceTaskId, input.targetTaskId),
                  eq(pacaTaskLinks.targetTaskId, input.sourceTaskId),
                ),
              )
            : and(
                eq(pacaTaskLinks.sourceTaskId, input.sourceTaskId),
                eq(pacaTaskLinks.targetTaskId, input.targetTaskId),
              );
        const [existing] = await transaction
          .select({ id: pacaTaskLinks.id })
          .from(pacaTaskLinks)
          .where(
            and(
              eq(pacaTaskLinks.projectId, input.projectId),
              eq(pacaTaskLinks.linkType, input.linkType),
              direction,
            ),
          )
          .limit(1);
        if (existing) throw new TaskLinkError(taskLinkErrorCodes.duplicate);

        const id = crypto.randomUUID();
        const [created] = await transaction
          .insert(pacaTaskLinks)
          .values({
            id,
            projectId: input.projectId,
            sourceTaskId: input.sourceTaskId,
            targetTaskId: input.targetTaskId,
            linkType: input.linkType,
            createdBy: input.actorUserId,
          })
          .returning();
        if (!created) throw new Error("TASK_LINK_CREATE_FAILED");

        await this.recordActivity(transaction, {
          projectId: input.projectId,
          taskId: input.sourceTaskId,
          actorUserId: input.actorUserId,
          activityType: "task.link.added",
          content: { target_task_id: input.targetTaskId, link_type: input.linkType },
        });

        return {
          id: created.id,
          projectId: created.projectId,
          sourceTaskId: created.sourceTaskId,
          targetTaskId: created.targetTaskId,
          linkType: created.linkType as LinkType,
          displayLinkType: created.linkType as LinkType,
          linkedTask: {
            id: target.id,
            taskNumber: target.taskNumber,
            title: target.title,
            statusId: target.statusId,
            taskTypeId: target.taskTypeId,
          },
          createdBy: created.createdBy,
          createdAt: created.createdAt,
        };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new TaskLinkError(taskLinkErrorCodes.duplicate);
      throw error;
    }
  }

  async delete(
    projectId: string,
    taskId: string,
    linkId: string,
    actorUserId: string,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await this.requireTask(projectId, taskId, transaction);
      const [link] = await transaction
        .select()
        .from(pacaTaskLinks)
        .where(and(eq(pacaTaskLinks.id, linkId), eq(pacaTaskLinks.projectId, projectId)))
        .for("update")
        .limit(1);
      if (!link || (link.sourceTaskId !== taskId && link.targetTaskId !== taskId)) {
        throw new TaskLinkError(taskLinkErrorCodes.notFound);
      }
      await transaction.delete(pacaTaskLinks).where(eq(pacaTaskLinks.id, linkId));
      await this.recordActivity(transaction, {
        projectId,
        taskId,
        actorUserId,
        activityType: "task.link.removed",
        content: { link_id: linkId },
      });
    });
  }

  private async requireTask(
    projectId: string,
    taskId: string,
    database: Pick<PacaDatabase, "select"> = this.database,
  ): Promise<void> {
    const [task] = await database
      .select({ id: pacaTasks.id })
      .from(pacaTasks)
      .where(
        and(
          eq(pacaTasks.id, taskId),
          eq(pacaTasks.projectId, projectId),
          isNull(pacaTasks.deletedAt),
        ),
      )
      .limit(1);
    if (!task) throw new TaskError(taskErrorCodes.notFound);
  }

  private async recordActivity(
    database: Pick<PacaDatabase, "insert" | "select">,
    input: {
      projectId: string;
      taskId: string;
      actorUserId: string;
      activityType: "task.link.added" | "task.link.removed";
      content: Record<string, unknown>;
    },
  ): Promise<void> {
    const [member] = await database
      .select({ id: pacaProjectMembers.id })
      .from(pacaProjectMembers)
      .where(
        and(
          eq(pacaProjectMembers.projectId, input.projectId),
          eq(pacaProjectMembers.userId, input.actorUserId),
        ),
      )
      .limit(1);
    await database.insert(pacaTaskActivities).values({
      id: crypto.randomUUID(),
      taskId: input.taskId,
      projectId: input.projectId,
      actorType: "user",
      actorId: input.actorUserId,
      actorUserId: input.actorUserId,
      actorAgentId: null,
      actorMemberId: member?.id ?? null,
      activityType: input.activityType,
      content: input.content,
    });
  }
}
