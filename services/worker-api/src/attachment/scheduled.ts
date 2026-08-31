import type { AppBindings } from "../bindings";
import type { AttachmentCleanupResult } from "./cleanup";
import { runAttachmentCleanup } from "./cleanup-runtime";

export const ATTACHMENT_CLEANUP_CRON = "15 10 * * *";

type AttachmentCleanupRunner = (env: AppBindings, now?: Date) => Promise<AttachmentCleanupResult>;

export type ScheduledAttachmentCleanupResult =
  | { status: "skipped"; reason: "disabled" }
  | ({ status: "completed" } & AttachmentCleanupResult);

export async function runScheduledAttachmentCleanup(
  controller: ScheduledController,
  env: AppBindings,
  cleanup: AttachmentCleanupRunner = runAttachmentCleanup,
): Promise<ScheduledAttachmentCleanupResult> {
  if (env.ATTACHMENT_CLEANUP_ENABLED !== "true") {
    return { status: "skipped", reason: "disabled" };
  }
  if (env.ENVIRONMENT !== "internal" && env.ENVIRONMENT !== "production") {
    throw new Error("ATTACHMENT_CLEANUP_ENVIRONMENT_INVALID");
  }
  if (controller.cron !== ATTACHMENT_CLEANUP_CRON) {
    throw new Error("ATTACHMENT_CLEANUP_CRON_INVALID");
  }

  return {
    status: "completed",
    ...(await cleanup(env, new Date(controller.scheduledTime))),
  };
}
