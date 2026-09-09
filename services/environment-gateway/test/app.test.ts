import { describe, expect, it, vi } from "vitest";

import { createGatewayApp, type GatewayBindings, type GatewayDependencies } from "../src/app";
import { connectionResponseSchema, type TicketClaims } from "../src/protocol";
import type { EnvironmentProvider } from "../src/provider";
import { ClassifiedEnvironmentProviderError } from "../src/provider-failure";

const NOW = new Date("2026-09-09T01:00:00.000Z");
const SECRET = "test-only-ticket-secret-with-at-least-32-bytes";
const ENVIRONMENT_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

function bindings(): GatewayBindings {
  return {
    AGENT_CONNECTIONS: Object.create(null) as Env["AGENT_CONNECTIONS"],
    CONNECTION_TICKET_SECRET: SECRET,
    CONNECTION_TICKETS: Object.create(null) as Env["CONNECTION_TICKETS"],
    ENVIRONMENT: "internal",
    PUBLIC_ORIGIN: "https://paca-env.howlearnwood.com",
    SANDBOXES: Object.create(null) as Env["SANDBOXES"],
  };
}

function issueBody(operationMode: "read" | "execute" = "execute") {
  return {
    protocolVersion: "paca.environment.gateway.v1",
    requestId: REQUEST_ID,
    environment: {
      id: ENVIRONMENT_ID,
      organizationId: "paca-default",
      projectId: PROJECT_ID,
      backend: "cloudflare-sandbox",
      reference: "environment-1",
    },
    operationMode,
    actor: { type: "agent", agentId: "agent-1", hostId: "host-1" },
    authorizationExpiresAt: new Date(NOW.getTime() + 45_000).toISOString(),
  } as const;
}

function issueRequest(operationMode: "read" | "execute" = "execute") {
  return new Request("https://environment-gateway.internal/v1/connections", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-paca-environment-gateway-protocol": "paca.environment.gateway.v1",
    },
    body: JSON.stringify(issueBody(operationMode)),
  });
}

function provider() {
  return {
    supports: vi.fn<EnvironmentProvider["supports"]>(
      (claims: TicketClaims) => claims.backend === "cloudflare-sandbox",
    ),
    status: vi.fn<EnvironmentProvider["status"]>(async (claims: TicketClaims) => ({
      environmentId: claims.environmentId,
      processes: [],
    })),
    prepare: vi.fn<EnvironmentProvider["prepare"]>(async () => undefined),
    terminal: vi.fn<EnvironmentProvider["terminal"]>(async () =>
      Promise.resolve(new Response("terminal-proxied")),
    ),
    terminate: vi.fn<EnvironmentProvider["terminate"]>(async () => undefined),
  } satisfies EnvironmentProvider;
}

function harness(input?: {
  provider?: ReturnType<typeof provider>;
  consumeTicket?: GatewayDependencies["consumeTicket"];
  isTicketAuthorized?: GatewayDependencies["isTicketAuthorized"];
  registerConnection?: GatewayDependencies["registerConnection"];
  revokeAgentConnections?: GatewayDependencies["revokeAgentConnections"];
  revokeProjectConnections?: GatewayDependencies["revokeProjectConnections"];
  wait?: GatewayDependencies["wait"];
}) {
  const environmentProvider = input?.provider ?? provider();
  const consumeTicket =
    input?.consumeTicket ?? vi.fn<GatewayDependencies["consumeTicket"]>(async () => true);
  const registerConnection =
    input?.registerConnection ?? vi.fn<GatewayDependencies["registerConnection"]>(async () => true);
  const isTicketAuthorized =
    input?.isTicketAuthorized ?? vi.fn<GatewayDependencies["isTicketAuthorized"]>(async () => true);
  const unregisterConnection = vi.fn<GatewayDependencies["unregisterConnection"]>(
    async () => undefined,
  );
  const revokeAgentConnections =
    input?.revokeAgentConnections ??
    vi.fn<GatewayDependencies["revokeAgentConnections"]>(async () => ({
      terminated: 0,
      pending: 0,
    }));
  const revokeProjectConnections =
    input?.revokeProjectConnections ??
    vi.fn<GatewayDependencies["revokeProjectConnections"]>(async () => ({
      terminated: 0,
      pending: 0,
    }));
  const dependencies: GatewayDependencies = {
    now: () => NOW,
    wait: input?.wait ?? vi.fn(async () => undefined),
    provider: () => environmentProvider,
    consumeTicket,
    registerConnection,
    isTicketAuthorized,
    unregisterConnection,
    revokeAgentConnections,
    revokeProjectConnections,
  };
  return {
    app: createGatewayApp(dependencies),
    env: bindings(),
    provider: environmentProvider,
    consumeTicket,
    registerConnection,
    isTicketAuthorized,
    unregisterConnection,
    revokeAgentConnections,
    revokeProjectConnections,
  };
}

async function issue(
  app: ReturnType<typeof createGatewayApp>,
  env: GatewayBindings,
  operationMode: "read" | "execute" = "execute",
) {
  const response = await app.fetch(issueRequest(operationMode), env);
  expect(response.status).toBe(200);
  return connectionResponseSchema.parse(await response.json());
}

function workerRequestUrl(connectionUrl: string): string {
  return connectionUrl.replace(/^wss:/u, "https:");
}

describe("Paca Environment Gateway", () => {
  it("issues a short-lived connection only through the private Service Binding origin", async () => {
    const test = harness();
    const connection = await issue(test.app, test.env);
    expect(connection).toMatchObject({
      requestId: REQUEST_ID,
      environmentId: ENVIRONMENT_ID,
      operationMode: "execute",
      transport: "websocket",
      url: "wss://paca-env.howlearnwood.com/v1/connect",
      expiresAt: new Date(NOW.getTime() + 45_000).toISOString(),
    });
    expect(connection.accessToken).not.toContain(ENVIRONMENT_ID);

    const publicAttempt = new Request("https://paca-env.howlearnwood.com/v1/connections", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-paca-environment-gateway-protocol": "paca.environment.gateway.v1",
      },
      body: JSON.stringify(issueBody()),
    });
    const rejected = await test.app.fetch(publicAttempt, test.env);
    expect(rejected.status).toBe(404);
  });

  it("keeps issued tickets below the API clock-skew ceiling and rejects overlong authorization", async () => {
    const test = harness();
    const response = await test.app.fetch(
      new Request("https://environment-gateway.internal/v1/connections", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-paca-environment-gateway-protocol": "paca.environment.gateway.v1",
        },
        body: JSON.stringify({
          ...issueBody(),
          authorizationExpiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
        }),
      }),
      test.env,
    );
    expect(response.status).toBe(200);
    const connection = connectionResponseSchema.parse(await response.json());
    expect(connection.expiresAt).toBe(new Date(NOW.getTime() + 55_000).toISOString());

    const excessive = await test.app.fetch(
      new Request("https://environment-gateway.internal/v1/connections", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-paca-environment-gateway-protocol": "paca.environment.gateway.v1",
        },
        body: JSON.stringify({
          ...issueBody(),
          authorizationExpiresAt: new Date(NOW.getTime() + 15 * 60_000 + 1_000).toISOString(),
        }),
      }),
      test.env,
    );
    expect(excessive.status).toBe(403);
  });

  it("consumes an execute ticket once and strips credentials before terminal proxying", async () => {
    const test = harness();
    const connection = await issue(test.app, test.env);
    const response = await test.app.fetch(
      new Request(workerRequestUrl(connection.url), {
        headers: {
          authorization: `Bearer ${connection.accessToken}`,
          cookie: "must-not-reach-sandbox=true",
          upgrade: "websocket",
        },
      }),
      test.env,
    );
    expect(response.status).toBe(200);
    expect(test.consumeTicket).toHaveBeenCalledWith(
      test.env,
      REQUEST_ID,
      new Date(NOW.getTime() + 45_000).getTime(),
    );
    expect(test.provider.terminal).toHaveBeenCalledOnce();
    expect(test.registerConnection).toHaveBeenCalledWith(test.env, {
      connectionId: REQUEST_ID,
      agentId: "agent-1",
      environmentId: ENVIRONMENT_ID,
      projectId: PROJECT_ID,
      backend: "cloudflare-sandbox",
      reference: "environment-1",
      sessionId: `paca-${REQUEST_ID}`,
      ticketIssuedAtMs: NOW.getTime(),
      authorizationExpiresAtMs: NOW.getTime() + 45_000,
    });
    const sessionId = test.provider.terminal.mock.calls[0]?.[1];
    expect(sessionId).toBe(`paca-${REQUEST_ID}`);
    const proxiedRequest = test.provider.terminal.mock.calls[0]?.[2];
    expect(proxiedRequest).toBeInstanceOf(Request);
    expect(proxiedRequest?.headers.get("authorization")).toBeNull();
    expect(proxiedRequest?.headers.get("cookie")).toBeNull();
  });

  it("rejects a replayed execute ticket before reaching the provider", async () => {
    const test = harness({ consumeTicket: vi.fn(async () => false) });
    const connection = await issue(test.app, test.env);
    const response = await test.app.fetch(
      new Request(workerRequestUrl(connection.url), {
        headers: { authorization: `Bearer ${connection.accessToken}`, upgrade: "websocket" },
      }),
      test.env,
    );
    expect(response.status).toBe(409);
    expect(test.provider.terminal).not.toHaveBeenCalled();
    expect(test.registerConnection).not.toHaveBeenCalled();
  });

  it("rejects a ticket issued before the Agent revocation barrier", async () => {
    const test = harness({ isTicketAuthorized: vi.fn(async () => false) });
    const connection = await issue(test.app, test.env, "read");
    const response = await test.app.fetch(
      new Request(connection.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${connection.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "status" }),
      }),
      test.env,
    );
    expect(response.status).toBe(401);
    expect(test.provider.status).not.toHaveBeenCalled();
    expect(test.isTicketAuthorized).toHaveBeenCalledWith(
      test.env,
      "agent-1",
      PROJECT_ID,
      NOW.getTime(),
    );
  });

  it("closes the check/register race when revocation lands during execute setup", async () => {
    const test = harness({ registerConnection: vi.fn(async () => false) });
    const connection = await issue(test.app, test.env);
    const response = await test.app.fetch(
      new Request(workerRequestUrl(connection.url), {
        headers: { authorization: `Bearer ${connection.accessToken}`, upgrade: "websocket" },
      }),
      test.env,
    );
    expect(response.status).toBe(401);
    expect(test.provider.terminal).toHaveBeenCalledOnce();
    expect(test.provider.terminate).toHaveBeenCalledWith(
      {
        connectionId: REQUEST_ID,
        agentId: "agent-1",
        environmentId: ENVIRONMENT_ID,
        projectId: PROJECT_ID,
        backend: "cloudflare-sandbox",
        reference: "environment-1",
        sessionId: `paca-${REQUEST_ID}`,
        ticketIssuedAtMs: NOW.getTime(),
        authorizationExpiresAtMs: NOW.getTime() + 45_000,
      },
      `paca-${REQUEST_ID}`,
    );
  });

  it("uses a reusable read ticket only for the structured status operation", async () => {
    const test = harness();
    const connection = await issue(test.app, test.env, "read");
    expect(connection).toMatchObject({
      transport: "http",
      url: "https://paca-env.howlearnwood.com/v1/connect",
    });
    const response = await test.app.fetch(
      new Request(connection.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${connection.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "status" }),
      }),
      test.env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      environmentId: ENVIRONMENT_ID,
      processes: [],
    });
    expect(test.consumeTicket).not.toHaveBeenCalled();
    expect(test.provider.status).toHaveBeenCalledOnce();
  });

  it("prepares an execute container without consuming its one-time terminal ticket", async () => {
    const test = harness();
    const connection = await issue(test.app, test.env);
    const response = await test.app.fetch(
      new Request(workerRequestUrl(connection.url), {
        method: "POST",
        headers: {
          authorization: `Bearer ${connection.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "prepare" }),
      }),
      test.env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-paca-provider-attempts")).toBe("1");
    await expect(response.json()).resolves.toEqual({
      status: "ready",
      environmentId: ENVIRONMENT_ID,
    });
    expect(test.provider.prepare).toHaveBeenCalledOnce();
    expect(test.consumeTicket).not.toHaveBeenCalled();
  });

  it("retries a classified transport failure within the bounded read-only budget", async () => {
    const environmentProvider = provider();
    environmentProvider.prepare
      .mockRejectedValueOnce({
        code: "RPC_TRANSPORT_ERROR",
        message: "transport lost",
        context: {
          kind: "peer_closed",
          originalMessage: "peer closed",
          errorName: "Error",
        },
      })
      .mockResolvedValueOnce(undefined);
    const wait = vi.fn(async () => undefined);
    const test = harness({ provider: environmentProvider, wait });
    const connection = await issue(test.app, test.env);
    const response = await test.app.fetch(
      new Request(workerRequestUrl(connection.url), {
        method: "POST",
        headers: {
          authorization: `Bearer ${connection.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "prepare" }),
      }),
      test.env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-paca-provider-attempts")).toBe("2");
    expect(wait).toHaveBeenCalledWith(500);
    expect(environmentProvider.prepare).toHaveBeenCalledTimes(2);
  });

  it("returns bounded retry metadata after transport retries are exhausted", async () => {
    const environmentProvider = provider();
    environmentProvider.status.mockRejectedValue({
      code: "RPC_TRANSPORT_ERROR",
      message: "transport lost",
      context: {
        kind: "peer_closed",
        originalMessage: "peer closed",
        errorName: "Error",
      },
    });
    const wait = vi.fn(async () => undefined);
    const test = harness({ provider: environmentProvider, wait });
    const connection = await issue(test.app, test.env, "read");
    const response = await test.app.fetch(
      new Request(connection.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${connection.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "status" }),
      }),
      test.env,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    await expect(response.json()).resolves.toEqual({
      code: "GATEWAY_PROVIDER_TRANSIENT",
      retryable: true,
      retryAfterMs: 500,
      attempts: 3,
    });
    expect(wait).toHaveBeenCalledTimes(2);
    expect(environmentProvider.status).toHaveBeenCalledTimes(3);
  });

  it("returns control to a fresh request instead of retrying a superseded runtime in place", async () => {
    const environmentProvider = provider();
    environmentProvider.status.mockRejectedValue(
      new ClassifiedEnvironmentProviderError({
        code: "GATEWAY_PROVIDER_TRANSIENT",
        retryable: true,
        retryAfterMs: 500,
        retryInRequest: false,
      }),
    );
    const wait = vi.fn(async () => undefined);
    const test = harness({ provider: environmentProvider, wait });
    const connection = await issue(test.app, test.env, "read");
    const response = await test.app.fetch(
      new Request(connection.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${connection.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "status" }),
      }),
      test.env,
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "GATEWAY_PROVIDER_TRANSIENT",
      retryable: true,
      attempts: 1,
    });
    expect(environmentProvider.status).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it("fails closed for unsupported providers and malformed public requests", async () => {
    const unavailable = provider();
    unavailable.supports.mockReturnValue(false);
    const test = harness({ provider: unavailable });
    const providerResponse = await test.app.fetch(issueRequest(), test.env);
    expect(providerResponse.status).toBe(503);
    await expect(providerResponse.json()).resolves.toEqual({
      code: "GATEWAY_PROVIDER_UNSUPPORTED",
      retryable: false,
      attempts: 1,
    });

    const missingTicket = await test.app.fetch(
      new Request("https://paca-env.howlearnwood.com/v1/connect"),
      test.env,
    );
    expect(missingTicket.status).toBe(401);
  });

  it("revokes registered Agent connections only through the private binding origin", async () => {
    const revokeAgentConnections = vi.fn<GatewayDependencies["revokeAgentConnections"]>(
      async () => ({ terminated: 2, pending: 0 }),
    );
    const test = harness({ revokeAgentConnections });
    const request = new Request("https://environment-gateway.internal/v1/revocations/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-paca-environment-gateway-protocol": "paca.environment.gateway.v1",
      },
      body: JSON.stringify({
        protocolVersion: "paca.environment.gateway.v1",
        agentId: "agent-1",
      }),
    });
    const response = await test.app.fetch(request, test.env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ terminated: 2, pending: 0 });
    expect(revokeAgentConnections).toHaveBeenCalledWith(test.env, "agent-1");

    const publicResponse = await test.app.fetch(
      new Request("https://paca-env.howlearnwood.com/v1/revocations/agent", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-paca-environment-gateway-protocol": "paca.environment.gateway.v1",
        },
        body: JSON.stringify({
          protocolVersion: "paca.environment.gateway.v1",
          agentId: "agent-1",
        }),
      }),
      test.env,
    );
    expect(publicResponse.status).toBe(404);
  });

  it("revokes only the requested project for a bounded set of Agents", async () => {
    const revokeProjectConnections = vi.fn<GatewayDependencies["revokeProjectConnections"]>(
      async () => ({ terminated: 2, pending: 1 }),
    );
    const test = harness({ revokeProjectConnections });
    const response = await test.app.fetch(
      new Request("https://environment-gateway.internal/v1/revocations/project", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-paca-environment-gateway-protocol": "paca.environment.gateway.v1",
        },
        body: JSON.stringify({
          protocolVersion: "paca.environment.gateway.v1",
          projectId: PROJECT_ID,
          agentIds: ["agent-1", "agent-2", "agent-1"],
        }),
      }),
      test.env,
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ terminated: 2, pending: 1 });
    expect(revokeProjectConnections).toHaveBeenCalledWith(test.env, PROJECT_ID, [
      "agent-1",
      "agent-2",
    ]);
  });

  it("does not register a connection when terminal proxy setup fails", async () => {
    const environmentProvider = provider();
    environmentProvider.terminal.mockRejectedValueOnce(new Error("provider unavailable"));
    const test = harness({ provider: environmentProvider });
    const connection = await issue(test.app, test.env);
    const response = await test.app.fetch(
      new Request(workerRequestUrl(connection.url), {
        headers: { authorization: `Bearer ${connection.accessToken}`, upgrade: "websocket" },
      }),
      test.env,
    );
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      code: "GATEWAY_PROVIDER_FAILED",
      retryable: false,
      attempts: 1,
    });
    expect(test.registerConnection).not.toHaveBeenCalled();
    expect(test.unregisterConnection).not.toHaveBeenCalled();
    expect(test.provider.terminate).not.toHaveBeenCalled();
  });
});
