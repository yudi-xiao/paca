import { describe, expect, it } from "vitest";
import {
  cronTriggerConfig,
  latestCronOccurrence,
  nextCronOccurrence,
} from "../src/automation/cron";

const now = new Date("2026-10-03T08:10:30Z");
describe("UTC Automation cron", () => {
  it("returns schedule-grid dates instead of wall-clock jitter", () => {
    expect(nextCronOccurrence("*/5 * * * *", now).toISOString()).toBe("2026-10-03T08:15:00.000Z");
    expect(latestCronOccurrence("*/5 * * * *", now).toISOString()).toBe("2026-10-03T08:10:00.000Z");
    expect(
      latestCronOccurrence("*/5 * * * *", new Date("2026-10-03T08:10:00Z")).toISOString(),
    ).toBe("2026-10-03T08:10:00.000Z");
    expect(nextCronOccurrence("0 9 * * MON-FRI", now).toISOString()).toBe(
      "2026-10-05T09:00:00.000Z",
    );
  });
  it("accepts standard OR semantics for restricted month days and weekdays", () => {
    expect(nextCronOccurrence("0 9 1 * MON", new Date("2026-10-01T10:00:00Z")).toISOString()).toBe(
      "2026-10-05T09:00:00.000Z",
    );
    expect(nextCronOccurrence("0 0 29 FEB *", new Date("2026-01-01T00:00:00Z")).toISOString()).toBe(
      "2028-02-29T00:00:00.000Z",
    );
  });
  it.each([
    "",
    "@hourly",
    "0 * * * * *",
    "61 * * * *",
    "* * * * * * *",
    "0 0 31 FEB *",
    "H * * * *",
    "h * * * *",
    "0 0 L * *",
    "0 0 * * 1#2",
    "0 0 ? * *",
    "*/0 * * * *",
  ])("rejects unsupported or impossible expression %s", (expression) => {
    expect(() => cronTriggerConfig({ cron_expression: expression })).toThrow(
      "AUTOMATION_CRON_CONFIG_INVALID",
    );
  });
  it("normalizes whitespace and rejects unreviewed config", () => {
    expect(cronTriggerConfig({ cron_expression: "  */5   * * * * " })).toEqual({
      cron_expression: "*/5 * * * *",
    });
    expect(() => cronTriggerConfig({ cron_expression: "* * * * *", timezone: "local" })).toThrow(
      "AUTOMATION_CRON_CONFIG_INVALID",
    );
    expect(() =>
      cronTriggerConfig({ cron_expression: "* * * * *", target_task_id: "wrong" }),
    ).toThrow("AUTOMATION_CRON_CONFIG_INVALID");
  });
});
