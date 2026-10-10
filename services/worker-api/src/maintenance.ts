import { recoverAbandonedAgentTaskLeases } from "./agent-task/recovery";
import { runScheduledAutomationCron } from "./automation/cron-scheduler";
import { runScheduledAutomationDueDates } from "./automation/due-date-scheduler";
import { dispatchAutomationOutbox } from "./automation/event-outbox";
import type { AppBindings } from "./bindings";
import { cleanGitHubWebhookReceipts } from "./github-delivery/webhook-runtime";
import { dispatchRealtimeOutbox } from "./realtime/outbox";

const defaults = {
  dueDates: runScheduledAutomationDueDates,
  cron: runScheduledAutomationCron,
  automation: dispatchAutomationOutbox,
  realtime: dispatchRealtimeOutbox,
  leases: recoverAbandonedAgentTaskLeases,
  githubReceipts: cleanGitHubWebhookReceipts,
};

/** A failed subsystem must not starve the other durable recovery loops. */
export async function runMinuteMaintenance(
  env: AppBindings,
  now: Date,
  dependencies: Partial<typeof defaults> = {},
): Promise<void> {
  const operations = { ...defaults, ...dependencies };
  const first = await Promise.allSettled([
    operations.dueDates(env, now, { limit: 50 }).then((result) => {
      if (result.created > 0)
        console.log(JSON.stringify({ event: "automation.due_dates.captured", ...result }));
    }),
    operations.cron(env, now, { limit: 50 }).then((result) => {
      if (result.created > 0)
        console.log(JSON.stringify({ event: "automation.cron.captured", ...result }));
    }),
    operations.realtime(env).then((result) => {
      if (result.claimed > 0 || result.failed > 0)
        console.log(
          JSON.stringify({ event: "realtime.outbox.dispatched", source: "scheduled", ...result }),
        );
    }),
    operations.leases(env).then((result) => {
      if (result.expired > 0)
        console.log(JSON.stringify({ event: "agent.task_leases.recovered", ...result }));
    }),
    operations.githubReceipts(env, now),
  ]);
  // Dispatch even when scanning fails: previously committed pending events still
  // need delivery. The combined scheduler bound matches this batch, leaving subsequent ticks
  // to drain durable backlogs without unbounded work in one invocation.
  const automation = await Promise.allSettled([
    operations.automation(env, { limit: 100 }).then((result) => {
      if (result.claimed > 0 || result.failed > 0)
        console.log(
          JSON.stringify({ event: "automation.outbox.dispatched", source: "scheduled", ...result }),
        );
    }),
  ]);
  const results = [...first, ...automation];
  const names = [
    "due_dates",
    "cron",
    "realtime",
    "agent_leases",
    "github_receipts",
    "automation_outbox",
  ];
  results.forEach((result, index) => {
    if (result.status !== "rejected") return;
    console.error(
      JSON.stringify({
        event: "scheduled.maintenance.failed",
        subsystem: names[index],
        errorCode: "SCHEDULED_MAINTENANCE_FAILED",
      }),
    );
  });
  if (results.some((result) => result.status === "rejected"))
    throw new Error("SCHEDULED_MAINTENANCE_FAILED");
}
