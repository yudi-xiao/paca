import { describe, expect, it, vi } from "vitest";

import {
  ATTACHMENT_CLEANUP_CRON,
  runScheduledAttachmentCleanup,
} from "../src/attachment/scheduled";
import type { AppBindings } from "../src/bindings";

function controller(cron = ATTACHMENT_CLEANUP_CRON): ScheduledController {
  return {
    cron,
    noRetry: vi.fn(),
    scheduledTime: Date.parse("2026-08-31T03:17:00.000Z"),
  };
}

function environment(overrides: Partial<AppBindings> = {}): AppBindings {
  return {
    ATTACHMENT_CLEANUP_ENABLED: "true",
    ENVIRONMENT: "internal",
    ...overrides,
  } as AppBindings;
}

describe("scheduled attachment cleanup", () => {
  it("fails closed without an explicit runtime enable flag", async () => {
    const cleanup = vi.fn(async () => ({ claimed: 0, purged: 0, failed: 0 }));

    await expect(
      runScheduledAttachmentCleanup(
        controller(),
        environment({ ATTACHMENT_CLEANUP_ENABLED: undefined }),
        cleanup,
      ),
    ).resolves.toEqual({ status: "skipped", reason: "disabled" });
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("rejects an enabled trigger outside an isolated runtime environment", async () => {
    await expect(
      runScheduledAttachmentCleanup(controller(), environment({ ENVIRONMENT: "development" })),
    ).rejects.toThrow("ATTACHMENT_CLEANUP_ENVIRONMENT_INVALID");
  });

  it("rejects a trigger that differs from the reviewed schedule", async () => {
    await expect(
      runScheduledAttachmentCleanup(controller("* * * * *"), environment()),
    ).rejects.toThrow("ATTACHMENT_CLEANUP_CRON_INVALID");
  });

  it("runs bounded cleanup at the scheduled time when every gate matches", async () => {
    const cleanup = vi.fn(async () => ({ claimed: 3, purged: 2, failed: 1 }));
    const scheduled = controller();
    const env = environment();

    await expect(runScheduledAttachmentCleanup(scheduled, env, cleanup)).resolves.toEqual({
      status: "completed",
      claimed: 3,
      purged: 2,
      failed: 1,
    });
    expect(cleanup).toHaveBeenCalledWith(env, new Date(scheduled.scheduledTime));
  });
});
