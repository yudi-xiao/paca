import * as z from "zod";
import type { SprintUpdateInput } from "./service";

export const sprintActionResultSchema = z
  .object({
    sprint_id: z.uuid(),
    applied: z.boolean(),
    moved_task_count: z.number().int().nonnegative(),
    changes: z
      .array(
        z
          .object({ field: z.string(), old: z.string().nullable(), new: z.string().nullable() })
          .strict(),
      )
      .max(5),
  })
  .strict();
export type SprintActionResult = z.infer<typeof sprintActionResultSchema>;
export type SprintAutomationAction = {
  projectId: string;
  runId: string;
  nodeId: string;
  taskId?: string | null;
  sprintId: string;
} & (
  | { type: "update_sprint"; update: SprintUpdateInput }
  | { type: "complete_sprint"; destinationSprintId: string | null }
);
export interface SprintAutomationRepository {
  resolveSprint(
    projectId: string,
    taskId: string | null,
    contextSprintId: string | null,
  ): Promise<string>;
  apply(action: SprintAutomationAction): Promise<SprintActionResult>;
}
/** Internal Workflow identity is verified at the repository boundary against its Run. */
export class SprintAutomationService {
  constructor(private readonly repository: SprintAutomationRepository) {}
  resolveSprint(projectId: string, taskId: string | null, contextSprintId: string | null) {
    return this.repository.resolveSprint(projectId, taskId, contextSprintId);
  }
  execute(action: SprintAutomationAction): Promise<SprintActionResult> {
    return this.repository.apply(action);
  }
}
