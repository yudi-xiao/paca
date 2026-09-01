import { routePartykitRequest } from "partyserver";

import { authorizeDocumentConnection } from "../document/realtime-auth";
import { authorizeRealtimeConnection } from "./auth";

export async function routeRealtimeRequest(request: Request, env: Env): Promise<Response | null> {
  return routePartykitRequest(request, env, {
    prefix: "ws/parties",
    cors: false,
    onBeforeConnect: (candidate, lobby) =>
      lobby.className === "DocumentParty"
        ? authorizeDocumentConnection(candidate, lobby, env)
        : authorizeRealtimeConnection(candidate, lobby, env),
    onBeforeRequest: () =>
      Response.json(
        { status: "error", code: "REALTIME_WEBSOCKET_REQUIRED" },
        { status: 426, headers: { "cache-control": "no-store" } },
      ),
    routingRetry: {
      maxAttempts: 3,
      baseDelayMs: 50,
      maxDelayMs: 250,
      onRetry({ attempt, maxAttempts, name }) {
        console.warn(
          JSON.stringify({
            event: "realtime.party.routing.retry",
            roomId: name,
            attempt,
            maxAttempts,
          }),
        );
      },
    },
  });
}
