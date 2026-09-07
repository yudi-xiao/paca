import { Buffer } from "node:buffer";
import * as z from "zod";

import type { PermissionDecision } from "../permission/service";
import type { Task } from "./service";
import { TaskError, taskErrorCodes } from "./service";

export type AssignedTaskCursor = {
  createdAt: string;
  id: string;
  importance: number;
};

export type AssignedTaskPage = {
  items: Task[];
  pageSize: number;
  nextCursor: string | null;
  totalCount: number;
};

export interface AssignedTaskRepository {
  listCandidateProjectIds(userId: string): Promise<string[]>;
  list(
    userId: string,
    readableProjectIds: string[],
    input: { pageSize: number; cursor: AssignedTaskCursor | null },
  ): Promise<{
    items: Array<{ task: Task; cursor: AssignedTaskCursor }>;
    totalCount: number;
    hasMore: boolean;
  }>;
}

export type CheckAssignedTaskProjectPermissions = (
  userId: string,
  projectIds: string[],
) => Promise<Map<string, PermissionDecision>>;

const assignedTaskCursorSchema = z
  .object({
    v: z.literal(1),
    scope: z.literal("assigned-to-me"),
    userId: z.string().min(1),
    createdAt: z.iso.datetime(),
    id: z.uuid(),
    importance: z.number().int().min(0).max(2_147_483_647),
  })
  .strict();

function encodeCursor(userId: string, cursor: AssignedTaskCursor): string {
  return Buffer.from(
    JSON.stringify({ v: 1, scope: "assigned-to-me", userId, ...cursor }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(userId: string, value: string | undefined): AssignedTaskCursor | null {
  if (!value) return null;
  try {
    const parsed = assignedTaskCursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    if (parsed.userId !== userId) throw new Error("invalid cursor owner");
    return {
      createdAt: parsed.createdAt,
      id: parsed.id,
      importance: parsed.importance,
    };
  } catch {
    throw new TaskError(taskErrorCodes.cursorInvalid);
  }
}

export class AssignedTaskService {
  constructor(
    private readonly repository: AssignedTaskRepository,
    private readonly checkProjectPermissions: CheckAssignedTaskProjectPermissions,
  ) {}

  async list(
    userId: string,
    input: { pageSize?: number; cursor?: string },
  ): Promise<AssignedTaskPage> {
    const pageSize = input.pageSize ?? 10;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new TaskError(taskErrorCodes.filterInvalid);
    }
    const cursor = decodeCursor(userId, input.cursor);
    const candidates = await this.repository.listCandidateProjectIds(userId);
    const readableProjectIds: string[] = [];

    const decisions = await this.checkProjectPermissions(userId, candidates);
    for (const projectId of candidates) {
      const decision = decisions.get(projectId);
      if (decision?.scopeExists && decision.allowed) readableProjectIds.push(projectId);
    }

    if (readableProjectIds.length === 0) {
      return { items: [], pageSize, nextCursor: null, totalCount: 0 };
    }
    const result = await this.repository.list(userId, readableProjectIds, { pageSize, cursor });
    const last = result.items.at(-1);
    return {
      items: result.items.map(({ task }) => task),
      pageSize,
      nextCursor: result.hasMore && last ? encodeCursor(userId, last.cursor) : null,
      totalCount: result.totalCount,
    };
  }
}
