import { createGatewayApp, type GatewayDependencies } from "./app";
import { CloudflareSandboxProvider } from "./provider";

export { Sandbox } from "@cloudflare/sandbox";
export { AgentConnectionRegistryDO } from "./connection-registry-do";
export { ConnectionTicketDO } from "./ticket-do";

const dependencies: GatewayDependencies = {
  now: () => new Date(),
  provider: (env) => new CloudflareSandboxProvider(env),
  consumeTicket: (env, ticketId, expiresAtMs) => {
    const id = env.CONNECTION_TICKETS.idFromName(ticketId);
    return env.CONNECTION_TICKETS.get(id).consume(expiresAtMs);
  },
  registerConnection: (env, connection) => {
    const id = env.AGENT_CONNECTIONS.idFromName(connection.agentId);
    return env.AGENT_CONNECTIONS.get(id).register(connection);
  },
  isTicketAuthorized: (env, agentId, ticketIssuedAtMs) => {
    const id = env.AGENT_CONNECTIONS.idFromName(agentId);
    return env.AGENT_CONNECTIONS.get(id).isTicketAuthorized(ticketIssuedAtMs);
  },
  unregisterConnection: (env, agentId, connectionId) => {
    const id = env.AGENT_CONNECTIONS.idFromName(agentId);
    return env.AGENT_CONNECTIONS.get(id).unregister(connectionId);
  },
  revokeAgentConnections: (env, agentId) => {
    const id = env.AGENT_CONNECTIONS.idFromName(agentId);
    return env.AGENT_CONNECTIONS.get(id).revokeAll();
  },
};

export default createGatewayApp(dependencies);
