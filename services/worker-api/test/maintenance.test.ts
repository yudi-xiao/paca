import { describe, expect, it, vi } from "vitest";
import { runScheduledAutomationCron } from "../src/automation/cron-scheduler";
import { runScheduledAutomationDueDates } from "../src/automation/due-date-scheduler";
import type { AppBindings } from "../src/bindings";
import { runMinuteMaintenance } from "../src/maintenance";

const env = {} as AppBindings;
const now = new Date("2026-10-02T00:00:00Z");
function dependencies() {
  return {
    cron: vi.fn().mockResolvedValue({ created: 0 }),
    dueDates: vi.fn().mockResolvedValue({ created: 0 }),
    realtime: vi.fn().mockResolvedValue({ claimed: 0, enqueued: 0, failed: 0 }),
    automation: vi.fn().mockResolvedValue({ claimed: 0, enqueued: 0, failed: 0 }),
    leases: vi.fn().mockResolvedValue({ expired: 0 }),
    githubReceipts: vi.fn().mockResolvedValue(undefined),
  };
}

describe("minute maintenance recovery isolation", () => {
  it("rejects invalid scan bounds and timestamps before touching persistence", async () => {
    const repository = { captureDue: vi.fn().mockResolvedValue({ created: 0 }) };
    for (const scheduler of [runScheduledAutomationCron, runScheduledAutomationDueDates]) {
      for (const limit of [0, -1, 101, 0.5, NaN]) {
        await expect(scheduler(env, now, { repository, limit })).rejects.toThrow(
          "AUTOMATION_SCHEDULE_LIMIT_INVALID",
        );
      }
      await expect(scheduler(env, new Date(NaN), { repository })).rejects.toThrow(
        "AUTOMATION_SCHEDULE_TIME_INVALID",
      );
    }
    expect(repository.captureDue).not.toHaveBeenCalled();
  });

  it("dispatches captured due events with a matching bound", async () => {
    const operations = dependencies();
    await runMinuteMaintenance(env, now, operations);
    expect(operations.dueDates).toHaveBeenCalledWith(env, now, { limit: 50 });
    expect(operations.cron).toHaveBeenCalledWith(env, now, { limit: 50 });
    expect(operations.automation).toHaveBeenCalledWith(env, { limit: 100 });
    expect(operations.dueDates.mock.invocationCallOrder[0]).toBeLessThan(
      operations.automation.mock.invocationCallOrder[0] as number,
    );
  });

  it.each([
    "dueDates",
    "cron",
    "realtime",
    "leases",
    "githubReceipts",
    "automation",
  ] as const)("keeps other recovery loops running after %s fails", async (name) => {
    const operations = dependencies();
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    operations[name].mockRejectedValue(new Error("private database details"));
    try {
      await expect(runMinuteMaintenance(env, now, operations)).rejects.toThrow(
        "SCHEDULED_MAINTENANCE_FAILED",
      );
      for (const operation of Object.values(operations)) expect(operation).toHaveBeenCalledOnce();
      expect(logger.mock.calls.flat().join("")).not.toContain("private database details");
    } finally {
      logger.mockRestore();
    }
  });
});
