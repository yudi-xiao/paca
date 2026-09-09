import { describe, expect, it, vi } from "vitest";

import { createGatewayApp, type GatewayBindings, type GatewayDependencies } from "../src/app";
import { connectionResponseSchema, type TicketClaims } from "../src/protocol";
import type { EnvironmentProvider } from "../src/provider";

const NOW = new Date("2026-09-09T01:00:00.000Z");
const SECRET = "test-only-ticket-secret-with-at-least-32-bytes";
const ENVIRONMENT_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

function bindings(): GatewayBindings {
  return {
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
    terminal: vi.fn<EnvironmentProvider["terminal"]>(async () =>
      Promise.resolve(new Response("terminal-proxied")),
    ),
  } satisfies EnvironmentProvider;
}

function harness(input?: {
  provider?: ReturnType<typeof provider>;
  consumeTicket?: GatewayDependencies["consumeTicket"];
}) {
  const environmentProvider = input?.provider ?? provider();
  const consumeTicket =
    input?.consumeTicket ?? vi.fn<GatewayDependencies["consumeTicket"]>(async () => true);
  const dependencies: GatewayDependencies = {
    now: () => NOW,
    provider: () => environmentProvider,
    consumeTicket,
  };
  return {
    app: createGatewayApp(dependencies),
    env: bindings(),
    provider: environmentProvider,
    consumeTicket,
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

describe("Paca Environment Gateway", () => {
  it("issues a short-lived connection only through the private Service Binding origin", async () => {
    const test = harness();
    const connection = await issue(test.app, test.env);
    expect(connection).toMatchObject({
      requestId: REQUEST_ID,
      environmentId: ENVIRONMENT_ID,
      operationMode: "execute",
      transport: "websocket",
      url: "https://paca-env.howlearnwood.com/v1/connect",
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

  it("consumes an execute ticket once and strips credentials before terminal proxying", async () => {
    const test = harness();
    const connection = await issue(test.app, test.env);
    const response = await test.app.fetch(
      new Request(connection.url, {
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
    const proxiedRequest = test.provider.terminal.mock.calls[0]?.[1];
    expect(proxiedRequest).toBeInstanceOf(Request);
    expect(proxiedRequest?.headers.get("authorization")).toBeNull();
    expect(proxiedRequest?.headers.get("cookie")).toBeNull();
  });

  it("rejects a replayed execute ticket before reaching the provider", async () => {
    const test = harness({ consumeTicket: vi.fn(async () => false) });
    const connection = await issue(test.app, test.env);
    const response = await test.app.fetch(
      new Request(connection.url, {
        headers: { authorization: `Bearer ${connection.accessToken}`, upgrade: "websocket" },
      }),
      test.env,
    );
    expect(response.status).toBe(409);
    expect(test.provider.terminal).not.toHaveBeenCalled();
  });

  it("uses a reusable read ticket only for the structured status operation", async () => {
    const test = harness();
    const connection = await issue(test.app, test.env, "read");
    expect(connection.transport).toBe("http");
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

  it("fails closed for unsupported providers and malformed public requests", async () => {
    const unavailable = provider();
    unavailable.supports.mockReturnValue(false);
    const test = harness({ provider: unavailable });
    const providerResponse = await test.app.fetch(issueRequest(), test.env);
    expect(providerResponse.status).toBe(503);

    const missingTicket = await test.app.fetch(
      new Request("https://paca-env.howlearnwood.com/v1/connect"),
      test.env,
    );
    expect(missingTicket.status).toBe(401);
  });
});
