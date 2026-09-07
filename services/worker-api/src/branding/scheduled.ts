import type { AppBindings } from "../bindings";
import { brandingRuntime } from "./runtime";

export type ScheduledBrandingCleanupResult =
  | { status: "skipped"; reason: "disabled" }
  | {
      status: "completed";
      claimed: number;
      purged: number;
      failed: number;
    };

export async function runScheduledBrandingCleanup(
  env: AppBindings,
  scheduledTime: number,
): Promise<ScheduledBrandingCleanupResult> {
  if (env.ATTACHMENT_CLEANUP_ENABLED !== "true") {
    return { status: "skipped", reason: "disabled" };
  }
  if (env.ENVIRONMENT !== "internal" && env.ENVIRONMENT !== "production") {
    throw new Error("BRANDING_CLEANUP_ENVIRONMENT_INVALID");
  }
  return {
    status: "completed",
    ...(await brandingRuntime.cleanup(env, new Date(scheduledTime))),
  };
}
