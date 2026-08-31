import { createApp } from "./app";
import { runScheduledAttachmentCleanup } from "./attachment/scheduled";
import { routeRealtimeRequest } from "./realtime/router";

export { ProjectParty, UserParty } from "./realtime/party";

const app = createApp();

export default {
  fetch(request, env, executionContext) {
    if (new URL(request.url).pathname.startsWith("/ws/parties/")) {
      return routeRealtimeRequest(request, env).then(
        (response) => response ?? Response.json({ status: "not_found" }, { status: 404 }),
      );
    }
    return app.fetch(request, env, executionContext);
  },
  async scheduled(controller, env) {
    const result = await runScheduledAttachmentCleanup(controller, env);
    console.log(JSON.stringify({ event: "attachment.cleanup.completed", ...result }));
  },
} satisfies ExportedHandler<Env>;
