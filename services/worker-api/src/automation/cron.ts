import { CronExpressionParser } from "cron-parser";
import * as z from "zod";
import { AutomationExecutionError } from "./errors";

const configSchema = z
  .object({
    cron_expression: z.string().trim().min(1).max(200),
    target_task_id: z.uuid().optional(),
  })
  .strict();

// Accept standard deterministic five-field cron only, including names, lists,
// ranges and steps. Seconds, macros, hash/random and platform-specific extensions
// would change the minute scheduler's product semantics.
export function parseCron(expression: string, currentDate: Date) {
  const normalized = expression.trim().replace(/\s+/gu, " ");
  if (
    normalized.split(" ").length !== 5 ||
    !/^[\dA-Za-z*,/\- ]+$/u.test(normalized) ||
    /[A-Za-z]/u.test(
      normalized.replace(
        /(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|SUN|MON|TUE|WED|THU|FRI|SAT)/giu,
        "",
      ),
    )
  ) {
    throw new AutomationExecutionError("AUTOMATION_CRON_CONFIG_INVALID");
  }
  try {
    return CronExpressionParser.parse(normalized, { currentDate, tz: "UTC" });
  } catch {
    throw new AutomationExecutionError("AUTOMATION_CRON_CONFIG_INVALID");
  }
}

export function cronTriggerConfig(config: Record<string, unknown>) {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) throw new AutomationExecutionError("AUTOMATION_CRON_CONFIG_INVALID");
  const expression = parsed.data.cron_expression.replace(/\s+/gu, " ");
  // Prove a next occurrence exists; impossible dates must not poison cron ticks.
  const next = parseCron(expression, new Date("2024-01-01T00:00:00Z"));
  try {
    next.next();
  } catch {
    throw new AutomationExecutionError("AUTOMATION_CRON_CONFIG_INVALID");
  }
  return { ...parsed.data, cron_expression: expression };
}

export function nextCronOccurrence(expression: string, after: Date): Date {
  try {
    return parseCron(expression, after).next().toDate();
  } catch {
    throw new AutomationExecutionError("AUTOMATION_CRON_CONFIG_INVALID");
  }
}

export function latestCronOccurrence(expression: string, at: Date): Date {
  try {
    return parseCron(expression, new Date(at.getTime() + 1))
      .prev()
      .toDate();
  } catch {
    throw new AutomationExecutionError("AUTOMATION_CRON_CONFIG_INVALID");
  }
}
