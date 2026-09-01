import { createApp } from "./app";
import { ATTACHMENT_CLEANUP_CRON, runScheduledAttachmentCleanup } from "./attachment/scheduled";
import { consumeDocumentMaterializationQueue } from "./document/materialization";
import { consumeRealtimeQueue } from "./realtime/consumer";
import { dispatchRealtimeOutbox } from "./realtime/outbox";
import { routeRealtimeRequest } from "./realtime/router";

export { AgentCoordinator } from "./agent-run/coordinator";
export { DocumentParty } from "./document/party";
export { ProjectParty, UserParty } from "./realtime/party";

const app = createApp();
const REALTIME_OUTBOX_CRON = "* * * * *";
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

async function dispatchAndLog(env: Env, source: "request" | "scheduled"): Promise<void> {
  const result = await dispatchRealtimeOutbox(env);
  if (result.claimed > 0 || result.failed > 0) {
    console.log(JSON.stringify({ event: "realtime.outbox.dispatched", source, ...result }));
  }
}

export default {
  async fetch(request, env, executionContext) {
    if (new URL(request.url).pathname.startsWith("/ws/parties/")) {
      return (
        (await routeRealtimeRequest(request, env)) ??
        Response.json({ status: "not_found" }, { status: 404 })
      );
    }
    const response = await app.fetch(request, env, executionContext);
    if (response.ok && MUTATING_METHODS.has(request.method)) {
      executionContext.waitUntil(dispatchAndLog(env, "request"));
    }
    return response;
  },
  async scheduled(controller, env) {
    if (controller.cron === REALTIME_OUTBOX_CRON) {
      await dispatchAndLog(env, "scheduled");
      return;
    }
    if (controller.cron === ATTACHMENT_CLEANUP_CRON) {
      const result = await runScheduledAttachmentCleanup(controller, env);
      console.log(JSON.stringify({ event: "attachment.cleanup.completed", ...result }));
      return;
    }
    console.warn(JSON.stringify({ event: "scheduled.unknown_cron", cron: controller.cron }));
  },
  async queue(batch, env) {
    if (batch.queue.startsWith("paca-document-materialization-")) {
      await consumeDocumentMaterializationQueue(batch, env);
      return;
    }
    await consumeRealtimeQueue(batch, env);
  },
} satisfies ExportedHandler<Env>;
