import { createGatewayApp, type GatewayDependencies } from "./app";
import { CloudflareSandboxProvider } from "./provider";

export { Sandbox } from "@cloudflare/sandbox";
export { AgentConnectionRegistryDO, UserConnectionRegistryDO } from "./connection-registry-do";
export { EnvironmentTicketBarrierDO } from "./environment-ticket-barrier-do";
export { ConnectionTicketDO } from "./ticket-do";

const dependencies: GatewayDependencies = {
  now: () => new Date(),
  wait: (milliseconds) => scheduler.wait(milliseconds),
  provider: (env) => new CloudflareSandboxProvider(env),
  consumeTicket: (env, ticketId, expiresAtMs) => {
    const id = env.CONNECTION_TICKETS.idFromName(ticketId);
    return env.CONNECTION_TICKETS.get(id).consume(expiresAtMs);
  },
  registerConnection: (env, actor, connection) => {
    const namespace = actor.type === "agent" ? env.AGENT_CONNECTIONS : env.USER_CONNECTIONS;
    const principalId = actor.type === "agent" ? actor.agentId : actor.userId;
    const id = namespace.idFromName(principalId);
    return namespace.get(id).register(connection);
  },
  isTicketAuthorized: async (env, actor, projectId, environmentId, ticketIssuedAtMs) => {
    const namespace = actor.type === "agent" ? env.AGENT_CONNECTIONS : env.USER_CONNECTIONS;
    const principalId = actor.type === "agent" ? actor.agentId : actor.userId;
    const id = namespace.idFromName(principalId);
    const barrierId = env.ENVIRONMENT_TICKET_BARRIERS.idFromName(environmentId);
    const [principalAuthorized, environmentAuthorized] = await Promise.all([
      namespace.get(id).isTicketAuthorized(projectId, environmentId, ticketIssuedAtMs),
      env.ENVIRONMENT_TICKET_BARRIERS.get(barrierId).isTicketAuthorized(ticketIssuedAtMs),
    ]);
    return principalAuthorized && environmentAuthorized;
  },
  unregisterConnection: (env, actor, connectionId) => {
    const namespace = actor.type === "agent" ? env.AGENT_CONNECTIONS : env.USER_CONNECTIONS;
    const principalId = actor.type === "agent" ? actor.agentId : actor.userId;
    const id = namespace.idFromName(principalId);
    return namespace.get(id).unregister(connectionId);
  },
  revokeAgentConnections: (env, agentId) => {
    const id = env.AGENT_CONNECTIONS.idFromName(agentId);
    return env.AGENT_CONNECTIONS.get(id).revokeAll();
  },
  revokeUserConnections: (env, userId) => {
    const id = env.USER_CONNECTIONS.idFromName(userId);
    return env.USER_CONNECTIONS.get(id).revokeAll();
  },
  revokeProjectConnections: async (env, projectId, agentIds, userIds) => {
    const results = await Promise.all(
      [
        ...agentIds.map((agentId) => [env.AGENT_CONNECTIONS, agentId] as const),
        ...userIds.map((userId) => [env.USER_CONNECTIONS, userId] as const),
      ].map(([namespace, principalId]) =>
        namespace.get(namespace.idFromName(principalId)).revokeProject(projectId),
      ),
    );
    return results.reduce(
      (total, result) => ({
        terminated: total.terminated + result.terminated,
        pending: total.pending + result.pending,
      }),
      { terminated: 0, pending: 0 },
    );
  },
  revokeEnvironmentConnections: async (env, projectId, environmentId, agentIds, userIds) => {
    const barrierId = env.ENVIRONMENT_TICKET_BARRIERS.idFromName(environmentId);
    await env.ENVIRONMENT_TICKET_BARRIERS.get(barrierId).revoke();
    const results = await Promise.all(
      [
        ...agentIds.map((agentId) => [env.AGENT_CONNECTIONS, agentId] as const),
        ...userIds.map((userId) => [env.USER_CONNECTIONS, userId] as const),
      ].map(([namespace, principalId]) =>
        namespace
          .get(namespace.idFromName(principalId))
          .revokeEnvironment(projectId, environmentId),
      ),
    );
    return results.reduce(
      (total, result) => ({
        terminated: total.terminated + result.terminated,
        pending: total.pending + result.pending,
      }),
      { terminated: 0, pending: 0 },
    );
  },
};

export default createGatewayApp(dependencies);
