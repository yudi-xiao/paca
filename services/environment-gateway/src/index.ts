import { createGatewayApp, type GatewayDependencies } from "./app";
import { CloudflareSandboxProvider } from "./provider";

export { Sandbox } from "@cloudflare/sandbox";
export { ConnectionTicketDO } from "./ticket-do";

const dependencies: GatewayDependencies = {
  now: () => new Date(),
  provider: (env) => new CloudflareSandboxProvider(env),
  consumeTicket: (env, ticketId, expiresAtMs) => {
    const id = env.CONNECTION_TICKETS.idFromName(ticketId);
    return env.CONNECTION_TICKETS.get(id).consume(expiresAtMs);
  },
};

export default createGatewayApp(dependencies);
