import { and, asc, eq, isNull } from "drizzle-orm";

import type { PacaDatabase } from "../database";
import { agent, user } from "../db/schema";
import { pacaProjectMembers, pacaTaskActivities, pacaTasks } from "../db/schema/paca";
import {
  type TaskActivity,
  TaskActivityError,
  type TaskActivityRepository,
  taskActivityErrorCodes,
} from "./activity-service";

type ActivityRow = typeof pacaTaskActivities.$inferSelect;

type HydratedActivityRow = ActivityRow & {
  actorName: string | null;
  actorEmail: string | null;
  actorImage: string | null;
  agentName: string | null;
};

function fromRow(row: HydratedActivityRow): TaskActivity {
  return {
    id: row.id,
    taskId: row.taskId,
    projectId: row.projectId,
    actorType: row.actorType as TaskActivity["actorType"],
    actorId: row.actorId,
    actorUserId: row.actorUserId,
    actorAgentId: row.actorAgentId,
    actorMemberId: row.actorMemberId,
    actorName: row.actorType === "agent" ? (row.agentName ?? "Agent") : (row.actorName ?? ""),
    actorUsername:
      row.actorType === "agent" ? (row.agentName ?? row.actorId) : (row.actorEmail ?? ""),
    actorAvatarUrl: row.actorType === "user" ? row.actorImage : null,
    activityType: row.activityType,
    content: row.content,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PostgresTaskActivityRepository implements TaskActivityRepository {
  constructor(private readonly database: PacaDatabase) {}

  async list(projectId: string, taskId: string): Promise<TaskActivity[]> {
    await this.requireTask(projectId, taskId);
    const rows = await this.database
      .select({
        id: pacaTaskActivities.id,
        taskId: pacaTaskActivities.taskId,
        projectId: pacaTaskActivities.projectId,
        actorType: pacaTaskActivities.actorType,
        actorId: pacaTaskActivities.actorId,
        actorUserId: pacaTaskActivities.actorUserId,
        actorAgentId: pacaTaskActivities.actorAgentId,
        actorMemberId: pacaTaskActivities.actorMemberId,
        activityType: pacaTaskActivities.activityType,
        content: pacaTaskActivities.content,
        createdAt: pacaTaskActivities.createdAt,
        updatedAt: pacaTaskActivities.updatedAt,
        deletedAt: pacaTaskActivities.deletedAt,
        actorName: user.name,
        actorEmail: user.email,
        actorImage: user.image,
        agentName: agent.name,
      })
      .from(pacaTaskActivities)
      .leftJoin(user, eq(user.id, pacaTaskActivities.actorUserId))
      .leftJoin(agent, eq(agent.id, pacaTaskActivities.actorAgentId))
      .where(
        and(
          eq(pacaTaskActivities.projectId, projectId),
          eq(pacaTaskActivities.taskId, taskId),
          isNull(pacaTaskActivities.deletedAt),
        ),
      )
      .orderBy(asc(pacaTaskActivities.createdAt), asc(pacaTaskActivities.id));
    return rows.map(fromRow);
  }

  async createComment(
    projectId: string,
    taskId: string,
    actorUserId: string,
    content: unknown[],
  ): Promise<TaskActivity> {
    const id = crypto.randomUUID();
    await this.database.transaction(async (transaction) => {
      await this.requireTask(projectId, taskId, transaction);
      const actorMemberId = await this.findMemberId(projectId, actorUserId, transaction);
      await transaction.insert(pacaTaskActivities).values({
        id,
        taskId,
        projectId,
        actorType: "user",
        actorId: actorUserId,
        actorUserId,
        actorAgentId: null,
        actorMemberId,
        activityType: "comment",
        content,
      });
    });
    return this.findById(projectId, taskId, id);
  }

  async updateComment(
    projectId: string,
    taskId: string,
    commentId: string,
    actorUserId: string,
    content: unknown[],
  ): Promise<TaskActivity> {
    await this.database.transaction(async (transaction) => {
      const [comment] = await transaction
        .select()
        .from(pacaTaskActivities)
        .where(
          and(
            eq(pacaTaskActivities.id, commentId),
            eq(pacaTaskActivities.projectId, projectId),
            eq(pacaTaskActivities.taskId, taskId),
            isNull(pacaTaskActivities.deletedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (!comment) {
        throw new TaskActivityError(taskActivityErrorCodes.commentNotFound);
      }
      if (comment.activityType !== "comment") {
        throw new TaskActivityError(taskActivityErrorCodes.commentTypeInvalid);
      }
      if (comment.actorType !== "user" || comment.actorUserId !== actorUserId) {
        throw new TaskActivityError(taskActivityErrorCodes.commentForbidden);
      }
      await transaction
        .update(pacaTaskActivities)
        .set({ content, updatedAt: new Date() })
        .where(eq(pacaTaskActivities.id, commentId));
    });
    return this.findById(projectId, taskId, commentId);
  }

  async deleteComment(
    projectId: string,
    taskId: string,
    commentId: string,
    actorUserId: string,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const [comment] = await transaction
        .select()
        .from(pacaTaskActivities)
        .where(
          and(
            eq(pacaTaskActivities.id, commentId),
            eq(pacaTaskActivities.projectId, projectId),
            eq(pacaTaskActivities.taskId, taskId),
            isNull(pacaTaskActivities.deletedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (!comment) {
        throw new TaskActivityError(taskActivityErrorCodes.commentNotFound);
      }
      if (comment.activityType !== "comment") {
        throw new TaskActivityError(taskActivityErrorCodes.commentTypeInvalid);
      }
      if (comment.actorType !== "user" || comment.actorUserId !== actorUserId) {
        throw new TaskActivityError(taskActivityErrorCodes.commentForbidden);
      }
      await transaction
        .update(pacaTaskActivities)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(pacaTaskActivities.id, commentId));
    });
  }

  private async findById(
    projectId: string,
    taskId: string,
    activityId: string,
  ): Promise<TaskActivity> {
    const [row] = await this.database
      .select({
        id: pacaTaskActivities.id,
        taskId: pacaTaskActivities.taskId,
        projectId: pacaTaskActivities.projectId,
        actorType: pacaTaskActivities.actorType,
        actorId: pacaTaskActivities.actorId,
        actorUserId: pacaTaskActivities.actorUserId,
        actorAgentId: pacaTaskActivities.actorAgentId,
        actorMemberId: pacaTaskActivities.actorMemberId,
        activityType: pacaTaskActivities.activityType,
        content: pacaTaskActivities.content,
        createdAt: pacaTaskActivities.createdAt,
        updatedAt: pacaTaskActivities.updatedAt,
        deletedAt: pacaTaskActivities.deletedAt,
        actorName: user.name,
        actorEmail: user.email,
        actorImage: user.image,
        agentName: agent.name,
      })
      .from(pacaTaskActivities)
      .leftJoin(user, eq(user.id, pacaTaskActivities.actorUserId))
      .leftJoin(agent, eq(agent.id, pacaTaskActivities.actorAgentId))
      .where(
        and(
          eq(pacaTaskActivities.id, activityId),
          eq(pacaTaskActivities.projectId, projectId),
          eq(pacaTaskActivities.taskId, taskId),
          isNull(pacaTaskActivities.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new TaskActivityError(taskActivityErrorCodes.commentNotFound);
    return fromRow(row);
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
    if (!task) throw new TaskActivityError(taskActivityErrorCodes.taskNotFound);
  }

  private async findMemberId(
    projectId: string,
    actorUserId: string,
    database: Pick<PacaDatabase, "select">,
  ): Promise<string | null> {
    const [member] = await database
      .select({ id: pacaProjectMembers.id })
      .from(pacaProjectMembers)
      .where(
        and(
          eq(pacaProjectMembers.projectId, projectId),
          eq(pacaProjectMembers.userId, actorUserId),
        ),
      )
      .limit(1);
    return member?.id ?? null;
  }
}
