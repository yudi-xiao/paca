import * as z from "zod";

export const automationSprintSnapshotSchema = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    name: z.string(),
    status: z.enum(["planned", "active", "completed"]),
    goal: z.string().nullable(),
    startDate: z.string().nullable(),
    endDate: z.string().nullable(),
  })
  .strict();
export type AutomationSprintSnapshot = z.infer<typeof automationSprintSnapshotSchema>;

export const automationWorkflowParamsSchema = z.object({ runId: z.uuid() }).strict();
export type AutomationWorkflowParams = z.infer<typeof automationWorkflowParamsSchema>;

export const automationRunSnapshotSchema = z
  .object({
    version: z.literal(1),
    projectId: z.uuid(),
    automationName: z.string().max(255).optional(),
    event: z
      .object({
        id: z.uuid(),
        type: z.enum([
          "task_created",
          "status_changed",
          "assignee_changed",
          "priority_changed",
          "tag_added",
          "predecessor_done",
          "due_date_reached",
          "cron",
          "sprint_created",
          "sprint_started",
          "sprint_completed",
          "sprint_deleted",
        ]),
        taskId: z.uuid().nullable(),
        sprintSnapshot: automationSprintSnapshotSchema.optional(),
        payload: z.record(z.string(), z.unknown()),
      })
      .strict(),
    nodes: z.array(
      z
        .object({
          id: z.uuid(),
          kind: z.enum(["trigger", "condition", "action"]),
          type: z.string(),
          config: z.record(z.string(), z.unknown()),
        })
        .strict(),
    ),
    edges: z.array(
      z
        .object({
          sourceNodeId: z.uuid(),
          sourceHandle: z.string().nullable(),
          targetNodeId: z.uuid(),
        })
        .strict(),
    ),
  })
  .strict();

export type AutomationRunSnapshot = z.infer<typeof automationRunSnapshotSchema>;
