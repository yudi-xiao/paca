import * as z from "zod";
import { automationDateSchema } from "../automation/date-config";
import { AutomationExecutionError } from "../automation/errors";
import type { SnapshotNode } from "../automation/execution-plan";
import type { SprintUpdateInput } from "./service";

const updateConfigSchema = z
  .object({
    sprint_update: z
      .object({
        name: z.string().trim().min(1).max(200).optional(),
        start_date: automationDateSchema.nullable().optional(),
        end_date: automationDateSchema.nullable().optional(),
        goal: z.string().trim().max(10_000).nullable().optional(),
        status: z.enum(["planned", "active", "completed"]).optional(),
      })
      .strict()
      .refine((update) => Object.keys(update).length > 0)
      .refine(
        (update) => !update.start_date || !update.end_date || update.start_date <= update.end_date,
      ),
  })
  .strict();
const completeConfigSchema = z
  .object({ move_to_sprint_id: z.uuid().nullable().optional() })
  .strict();
export type SprintActionConfig =
  | { type: "update_sprint"; update: SprintUpdateInput }
  | { type: "complete_sprint"; destinationSprintId: string | null };

export function sprintActionFromNode(
  node: Pick<SnapshotNode, "kind" | "type" | "config">,
): SprintActionConfig {
  if (node.kind === "action" && node.type === "update_sprint") {
    const parsed = updateConfigSchema.safeParse(node.config);
    if (!parsed.success)
      throw new AutomationExecutionError("AUTOMATION_UPDATE_SPRINT_CONFIG_INVALID");
    const update = parsed.data.sprint_update;
    // Omitted fields must stay omitted: the repository uses this patch for its audit.
    return {
      type: "update_sprint",
      update: {
        ...(update.name !== undefined ? { name: update.name } : {}),
        ...(update.start_date !== undefined ? { startDate: update.start_date } : {}),
        ...(update.end_date !== undefined ? { endDate: update.end_date } : {}),
        ...(update.goal !== undefined ? { goal: update.goal } : {}),
        ...(update.status !== undefined ? { status: update.status } : {}),
      },
    };
  }
  if (node.kind === "action" && node.type === "complete_sprint") {
    const parsed = completeConfigSchema.safeParse(node.config);
    if (!parsed.success)
      throw new AutomationExecutionError("AUTOMATION_COMPLETE_SPRINT_CONFIG_INVALID");
    return { type: "complete_sprint", destinationSprintId: parsed.data.move_to_sprint_id ?? null };
  }
  throw new AutomationExecutionError("AUTOMATION_ACTION_UNSUPPORTED");
}
