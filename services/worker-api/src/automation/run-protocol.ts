import * as z from "zod";

export const automationWorkflowParamsSchema = z.object({ runId: z.uuid() }).strict();
export type AutomationWorkflowParams = z.infer<typeof automationWorkflowParamsSchema>;

export const automationRunSnapshotSchema = z
  .object({
    version: z.literal(1),
    projectId: z.uuid(),
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
        ]),
        taskId: z.uuid(),
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
