import { describe, expect, it, vi } from "vitest";

import {
  EnvironmentConnectionError,
  type EnvironmentConnectionGateway,
  environmentConnectionErrorCodes,
} from "../src/environment/service";
import { ServiceBindingEnvironmentConnectionGateway } from "../src/environment/service-binding-gateway";

const NOW = new Date("2026-09-08T05:00:00.000Z");
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT_ID = "88888888-8888-4888-8888-888888888888";
const REQUEST_ID = "55555555-5555-4555-8555-555555555555";

function input(): Parameters<EnvironmentConnectionGateway["issue"]>[0] {
  return {
    requestId: REQUEST_ID,
    scope: {
      environmentId: ENVIRONMENT_ID,
      organizationId: "paca-default",
      projectId: PROJECT_ID,
      backend: "cloudflare-computer",
      gatewayReference: "workspace-1",
    },
    operationMode: "execute",
    actor: { type: "agent", agentId: "agent-1", hostId: "host-1" },
    authorizationExpiresAt: new Date(NOW.getTime() + 45_000),
  };
}

function gatewayResponse(): Record<string, unknown> {
  return {
    protocolVersion: "paca.environment.connection.v1",
    requestId: REQUEST_ID,
    environmentId: ENVIRONMENT_ID,
    operationMode: "execute",
    transport: "websocket",
    url: "wss://environment-gateway.paca.test/v1/connect",
    accessToken: "short-lived-ticket",
    expiresAt: new Date(NOW.getTime() + 30_000).toISOString(),
  };
}

function fetcher(fetch: Fetcher["fetch"]): Fetcher {
  return {
    fetch,
    connect: () => {
      throw new Error("not implemented in test");
    },
  };
}

describe("ServiceBindingEnvironmentConnectionGateway", () => {
  it("fails closed when the private Service Binding is absent", async () => {
    const gateway = new ServiceBindingEnvironmentConnectionGateway();
    await expect(gateway.issue(input())).rejects.toMatchObject({
      code: environmentConnectionErrorCodes.gatewayUnavailable,
    });
  });

  it("sends only the versioned, scoped request and parses a bounded response", async () => {
    const fetch = vi.fn<Fetcher["fetch"]>(async (requestInfo, init) => {
      expect(String(requestInfo)).toBe("https://environment-gateway.internal/v1/connections");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("x-paca-environment-gateway-protocol")).toBe(
        "paca.environment.gateway.v1",
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        protocolVersion: "paca.environment.gateway.v1",
        requestId: REQUEST_ID,
        environment: {
          id: ENVIRONMENT_ID,
          organizationId: "paca-default",
          projectId: PROJECT_ID,
          backend: "cloudflare-computer",
          reference: "workspace-1",
        },
        operationMode: "execute",
        actor: { type: "agent", agentId: "agent-1", hostId: "host-1" },
        authorizationExpiresAt: new Date(NOW.getTime() + 45_000).toISOString(),
      });
      return Response.json(gatewayResponse());
    });
    const gateway = new ServiceBindingEnvironmentConnectionGateway(fetcher(fetch));

    await expect(gateway.issue(input())).resolves.toMatchObject({
      environmentId: ENVIRONMENT_ID,
      expiresAt: new Date(NOW.getTime() + 30_000),
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("issues an explicit Better Auth user principal and revokes its sessions privately", async () => {
    const fetch = vi.fn<Fetcher["fetch"]>(async (requestInfo, init) => {
      if (String(requestInfo).endsWith("/v1/connections")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          actor: { type: "user", userId: "user-1" },
        });
        return Response.json(gatewayResponse());
      }
      expect(String(requestInfo)).toBe("https://environment-gateway.internal/v1/revocations/user");
      expect(JSON.parse(String(init?.body))).toEqual({
        protocolVersion: "paca.environment.gateway.v1",
        userId: "user-1",
      });
      return Response.json({ terminated: 1, pending: 0 });
    });
    const gateway = new ServiceBindingEnvironmentConnectionGateway(fetcher(fetch));

    await expect(
      gateway.issue({ ...input(), actor: { type: "user", userId: "user-1" } }),
    ).resolves.toMatchObject({ environmentId: ENVIRONMENT_ID });
    await expect(gateway.revokeUserConnections("user-1")).resolves.toEqual({
      terminated: 1,
      pending: 0,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("requests project-scoped connection termination for a bounded Agent batch", async () => {
    const fetch = vi.fn<Fetcher["fetch"]>(async (requestInfo, init) => {
      expect(String(requestInfo)).toBe(
        "https://environment-gateway.internal/v1/revocations/project",
      );
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("x-paca-environment-gateway-protocol")).toBe(
        "paca.environment.gateway.v1",
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        protocolVersion: "paca.environment.gateway.v1",
        projectId: PROJECT_ID,
        agentIds: ["agent-1", "agent-2"],
        userIds: [],
      });
      return Response.json({ terminated: 2, pending: 0 });
    });
    const gateway = new ServiceBindingEnvironmentConnectionGateway(fetcher(fetch));

    await expect(
      gateway.revokeProjectConnections(PROJECT_ID, ["agent-1", "agent-2"]),
    ).resolves.toEqual({ terminated: 2, pending: 0 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("requests environment-scoped connection termination through the private binding", async () => {
    const fetch = vi.fn<Fetcher["fetch"]>(async (requestInfo, init) => {
      expect(String(requestInfo)).toBe(
        "https://environment-gateway.internal/v1/revocations/environment",
      );
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");
      expect(JSON.parse(String(init?.body))).toEqual({
        protocolVersion: "paca.environment.gateway.v1",
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
        agentIds: ["agent-1", "agent-2"],
        userIds: [],
      });
      return Response.json({ terminated: 1, pending: 0 });
    });
    const gateway = new ServiceBindingEnvironmentConnectionGateway(fetcher(fetch));

    await expect(
      gateway.revokeEnvironmentConnections(PROJECT_ID, ENVIRONMENT_ID, ["agent-1", "agent-2"]),
    ).resolves.toEqual({ terminated: 1, pending: 0 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("requests Agent-wide connection termination through the private binding", async () => {
    const fetch = vi.fn<Fetcher["fetch"]>(async (requestInfo, init) => {
      expect(String(requestInfo)).toBe("https://environment-gateway.internal/v1/revocations/agent");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("x-paca-environment-gateway-protocol")).toBe(
        "paca.environment.gateway.v1",
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        protocolVersion: "paca.environment.gateway.v1",
        agentId: "agent-1",
      });
      return Response.json({ terminated: 1, pending: 0 });
    });
    const gateway = new ServiceBindingEnvironmentConnectionGateway(fetcher(fetch));

    await expect(gateway.revokeAgentConnections("agent-1")).resolves.toEqual({
      terminated: 1,
      pending: 0,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("accepts a queued connection termination response", async () => {
    const gateway = new ServiceBindingEnvironmentConnectionGateway(
      fetcher(async () => Response.json({ terminated: 0, pending: 1 }, { status: 202 })),
    );
    await expect(gateway.revokeAgentConnections("agent-1")).resolves.toEqual({
      terminated: 0,
      pending: 1,
    });
  });

  it("preserves bounded retry metadata from a transient Gateway failure", async () => {
    const gateway = new ServiceBindingEnvironmentConnectionGateway(
      fetcher(async () =>
        Response.json(
          {
            code: "GATEWAY_PROVIDER_CAPACITY",
            retryable: true,
            retryAfterMs: 1_500,
            attempts: 3,
          },
          { status: 503 },
        ),
      ),
    );

    await expect(gateway.issue(input())).rejects.toMatchObject({
      code: environmentConnectionErrorCodes.gatewayUnavailable,
      retryable: true,
      retryAfterMs: 1_500,
    });
  });

  it("distinguishes unsupported and uncertain provider failures from retryable outages", async () => {
    const unsupported = new ServiceBindingEnvironmentConnectionGateway(
      fetcher(async () =>
        Response.json(
          { code: "GATEWAY_PROVIDER_UNSUPPORTED", retryable: false, attempts: 1 },
          { status: 503 },
        ),
      ),
    );
    const uncertain = new ServiceBindingEnvironmentConnectionGateway(
      fetcher(async () =>
        Response.json(
          { code: "GATEWAY_PROVIDER_OPERATION_UNCERTAIN", retryable: false, attempts: 1 },
          { status: 502 },
        ),
      ),
    );

    await expect(unsupported.issue(input())).rejects.toMatchObject({
      code: environmentConnectionErrorCodes.providerUnsupported,
      retryable: false,
    });
    await expect(uncertain.issue(input())).rejects.toMatchObject({
      code: environmentConnectionErrorCodes.providerFailed,
      retryable: false,
    });
  });

  it("rejects an unbounded or malformed Gateway failure envelope", async () => {
    const gateway = new ServiceBindingEnvironmentConnectionGateway(
      fetcher(async () =>
        Response.json(
          {
            code: "GATEWAY_PROVIDER_CAPACITY",
            retryable: true,
            retryAfterMs: 60_000,
            attempts: 3,
          },
          { status: 503 },
        ),
      ),
    );
    await expect(gateway.issue(input())).rejects.toMatchObject({
      code: environmentConnectionErrorCodes.gatewayResponseInvalid,
      retryable: false,
    });
  });

  it.each([
    () => new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }),
    () => Response.json({ ...gatewayResponse(), unexpected: true }),
    () =>
      new Response(JSON.stringify(gatewayResponse()), {
        headers: { "content-type": "application/json", "content-length": "999999" },
      }),
  ])("rejects malformed and oversized gateway responses", async (response) => {
    const gateway = new ServiceBindingEnvironmentConnectionGateway(fetcher(async () => response()));
    await expect(gateway.issue(input())).rejects.toBeInstanceOf(EnvironmentConnectionError);
    await expect(gateway.issue(input())).rejects.toMatchObject({
      code: environmentConnectionErrorCodes.gatewayResponseInvalid,
    });
  });

  it("rejects a chunked response after the configured byte limit", async () => {
    const oversized = new Uint8Array(32 * 1_024 + 1);
    const gateway = new ServiceBindingEnvironmentConnectionGateway(
      fetcher(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(oversized);
                controller.close();
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
      ),
    );

    await expect(gateway.issue(input())).rejects.toMatchObject({
      code: environmentConnectionErrorCodes.gatewayResponseInvalid,
    });
  });
});
