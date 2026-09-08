import { describe, expect, it, vi } from "vitest";

import {
  type EnvironmentConnection,
  EnvironmentConnectionError,
  EnvironmentConnectionService,
  type EnvironmentScope,
  environmentConnectionErrorCodes,
} from "../src/environment/service";

const NOW = new Date("2026-09-08T05:00:00.000Z");
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT_ID = "88888888-8888-4888-8888-888888888888";
const REQUEST_ID = "55555555-5555-4555-8555-555555555555";

const scope: EnvironmentScope = {
  environmentId: ENVIRONMENT_ID,
  organizationId: "paca-default",
  projectId: PROJECT_ID,
  backend: "cloudflare-computer",
  gatewayReference: "workspace-1",
};

function connection(overrides: Partial<EnvironmentConnection> = {}): EnvironmentConnection {
  return {
    protocolVersion: "paca.environment.connection.v1",
    requestId: REQUEST_ID,
    environmentId: ENVIRONMENT_ID,
    operationMode: "execute",
    transport: "websocket",
    url: "wss://environment-gateway.paca.test/v1/connect",
    accessToken: "short-lived-ticket",
    expiresAt: new Date(NOW.getTime() + 30_000),
    ...overrides,
  };
}

function input() {
  return {
    requestId: REQUEST_ID,
    organizationId: "paca-default",
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    operationMode: "execute" as const,
    actor: { agentId: "agent-1", hostId: "host-1" },
    authorizationExpiresAt: new Date(NOW.getTime() + 45_000),
  };
}

describe("EnvironmentConnectionService", () => {
  it("revalidates the exact scope before requesting a short-lived gateway connection", async () => {
    const issue = vi.fn(async () => connection());
    const service = new EnvironmentConnectionService(
      { find: async () => scope },
      { issue },
      () => NOW,
    );

    await expect(service.connect(input())).resolves.toEqual(connection());
    expect(issue).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      scope,
      operationMode: "execute",
      actor: { agentId: "agent-1", hostId: "host-1" },
      authorizationExpiresAt: new Date(NOW.getTime() + 45_000),
    });
  });

  it.each([
    null,
    { ...scope, organizationId: "other-org" },
    { ...scope, projectId: "22222222-2222-4222-8222-222222222222" },
  ])("rejects a missing or mismatched environment scope without calling the gateway", async (found) => {
    const issue = vi.fn();
    const service = new EnvironmentConnectionService(
      { find: async () => found },
      { issue },
      () => NOW,
    );

    await expect(service.connect(input())).rejects.toMatchObject({
      code: environmentConnectionErrorCodes.scopeMismatch,
    });
    expect(issue).not.toHaveBeenCalled();
  });

  it("rejects expired authorization before reading the environment scope", async () => {
    const find = vi.fn();
    const service = new EnvironmentConnectionService({ find }, { issue: vi.fn() }, () => NOW);

    await expect(
      service.connect({ ...input(), authorizationExpiresAt: NOW }),
    ).rejects.toMatchObject({ code: environmentConnectionErrorCodes.authorizationExpired });
    expect(find).not.toHaveBeenCalled();
  });

  it.each([
    connection({ environmentId: "99999999-9999-4999-8999-999999999999" }),
    connection({ requestId: "99999999-9999-4999-8999-999999999999" }),
    connection({ operationMode: "read" }),
    connection({ url: "ws://environment-gateway.paca.test/v1/connect" }),
    connection({ url: "wss://environment-gateway.paca.test/v1/connect?ticket=secret" }),
    connection({ accessToken: "" }),
    connection({ expiresAt: NOW }),
    connection({ expiresAt: new Date(NOW.getTime() + 45_001) }),
  ])("rejects an unbound or unsafe gateway response", async (result) => {
    const service = new EnvironmentConnectionService(
      { find: async () => scope },
      { issue: async () => result },
      () => NOW,
    );

    await expect(service.connect(input())).rejects.toBeInstanceOf(EnvironmentConnectionError);
    await expect(service.connect(input())).rejects.toMatchObject({
      code: environmentConnectionErrorCodes.gatewayResponseInvalid,
    });
  });
});
