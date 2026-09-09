import * as z from "zod";

import {
  type EnvironmentConnection,
  EnvironmentConnectionError,
  type EnvironmentConnectionGateway,
  environmentConnectionErrorCodes,
  environmentConnectionProtocol,
} from "./service";

const ENVIRONMENT_GATEWAY_ENDPOINT = "https://environment-gateway.internal/v1/connections";
const ENVIRONMENT_GATEWAY_REVOCATION_ENDPOINT =
  "https://environment-gateway.internal/v1/revocations/agent";
const ENVIRONMENT_GATEWAY_PROJECT_REVOCATION_ENDPOINT =
  "https://environment-gateway.internal/v1/revocations/project";
const ENVIRONMENT_GATEWAY_RESOURCE_REVOCATION_ENDPOINT =
  "https://environment-gateway.internal/v1/revocations/environment";
const ENVIRONMENT_GATEWAY_PROTOCOL = "paca.environment.gateway.v1";
const MAX_GATEWAY_RESPONSE_BYTES = 32 * 1_024;

const responseSchema = z
  .object({
    protocolVersion: z.literal(environmentConnectionProtocol),
    requestId: z.uuid(),
    environmentId: z.uuid(),
    operationMode: z.enum(["read", "execute"]),
    transport: z.enum(["http", "websocket"]),
    url: z.string().min(1).max(2_048),
    accessToken: z.string().min(1).max(4_096),
    expiresAt: z.iso.datetime(),
  })
  .strict();

const revocationResponseSchema = z
  .object({
    terminated: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
  })
  .strict();

const gatewayProviderFailureSchema = z
  .object({
    code: z.enum([
      "GATEWAY_PROVIDER_STARTING",
      "GATEWAY_PROVIDER_CAPACITY",
      "GATEWAY_PROVIDER_TRANSIENT",
      "GATEWAY_PROVIDER_OPERATION_UNCERTAIN",
      "GATEWAY_PROVIDER_FAILED",
      "GATEWAY_PROVIDER_UNSUPPORTED",
    ]),
    retryable: z.boolean(),
    retryAfterMs: z.number().int().min(100).max(10_000).optional(),
    attempts: z.number().int().min(1).max(3),
  })
  .strict();

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const size = Number(declaredLength);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_GATEWAY_RESPONSE_BYTES) {
      throw new EnvironmentConnectionError(environmentConnectionErrorCodes.gatewayResponseInvalid);
    }
  }
  if (!response.body) {
    throw new EnvironmentConnectionError(environmentConnectionErrorCodes.gatewayResponseInvalid);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_GATEWAY_RESPONSE_BYTES) {
        await reader.cancel();
        throw new EnvironmentConnectionError(
          environmentConnectionErrorCodes.gatewayResponseInvalid,
        );
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new EnvironmentConnectionError(environmentConnectionErrorCodes.gatewayResponseInvalid);
  }
}

async function throwGatewayIssueFailure(response: Response): Promise<never> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    void response.body?.cancel().catch(() => undefined);
    throw new EnvironmentConnectionError(environmentConnectionErrorCodes.gatewayResponseInvalid);
  }
  const parsed = gatewayProviderFailureSchema.safeParse(await readBoundedJson(response));
  if (!parsed.success) {
    throw new EnvironmentConnectionError(environmentConnectionErrorCodes.gatewayResponseInvalid);
  }
  if (parsed.data.code === "GATEWAY_PROVIDER_UNSUPPORTED") {
    throw new EnvironmentConnectionError(environmentConnectionErrorCodes.providerUnsupported);
  }
  if (!parsed.data.retryable) {
    throw new EnvironmentConnectionError(environmentConnectionErrorCodes.providerFailed);
  }
  throw new EnvironmentConnectionError(environmentConnectionErrorCodes.gatewayUnavailable, {
    retryable: true,
    ...(parsed.data.retryAfterMs === undefined ? {} : { retryAfterMs: parsed.data.retryAfterMs }),
  });
}

export class ServiceBindingEnvironmentConnectionGateway implements EnvironmentConnectionGateway {
  constructor(private readonly binding?: Fetcher) {}

  async issue(
    input: Parameters<EnvironmentConnectionGateway["issue"]>[0],
  ): Promise<EnvironmentConnection> {
    if (!this.binding) {
      throw new EnvironmentConnectionError(environmentConnectionErrorCodes.gatewayUnavailable);
    }

    let response: Response;
    try {
      response = await this.binding.fetch(ENVIRONMENT_GATEWAY_ENDPOINT, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          "x-paca-environment-gateway-protocol": ENVIRONMENT_GATEWAY_PROTOCOL,
        },
        body: JSON.stringify({
          protocolVersion: ENVIRONMENT_GATEWAY_PROTOCOL,
          requestId: input.requestId,
          environment: {
            id: input.scope.environmentId,
            organizationId: input.scope.organizationId,
            projectId: input.scope.projectId,
            backend: input.scope.backend,
            reference: input.scope.gatewayReference,
          },
          operationMode: input.operationMode,
          actor: {
            type: "agent",
            agentId: input.actor.agentId,
            hostId: input.actor.hostId,
          },
          authorizationExpiresAt: input.authorizationExpiresAt.toISOString(),
        }),
      });
    } catch {
      throw new EnvironmentConnectionError(environmentConnectionErrorCodes.gatewayUnavailable);
    }

    if (response.status < 200 || response.status >= 300) {
      return throwGatewayIssueFailure(response);
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (contentType !== "application/json") {
      void response.body?.cancel().catch(() => undefined);
      throw new EnvironmentConnectionError(environmentConnectionErrorCodes.gatewayResponseInvalid);
    }
    const parsed = responseSchema.safeParse(await readBoundedJson(response));
    if (!parsed.success) {
      throw new EnvironmentConnectionError(environmentConnectionErrorCodes.gatewayResponseInvalid);
    }
    return { ...parsed.data, expiresAt: new Date(parsed.data.expiresAt) };
  }

  async revokeAgentConnections(agentId: string): Promise<{ terminated: number; pending: number }> {
    if (!this.binding) {
      throw new EnvironmentConnectionError(environmentConnectionErrorCodes.gatewayUnavailable);
    }

    let response: Response;
    try {
      response = await this.binding.fetch(ENVIRONMENT_GATEWAY_REVOCATION_ENDPOINT, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          "x-paca-environment-gateway-protocol": ENVIRONMENT_GATEWAY_PROTOCOL,
        },
        body: JSON.stringify({
          protocolVersion: ENVIRONMENT_GATEWAY_PROTOCOL,
          agentId,
        }),
      });
    } catch {
      throw new EnvironmentConnectionError(environmentConnectionErrorCodes.gatewayUnavailable);
    }

    if (response.status < 200 || response.status >= 300) {
      void response.body?.cancel().catch(() => undefined);
      throw new EnvironmentConnectionError(environmentConnectionErrorCodes.gatewayUnavailable);
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (contentType !== "application/json") {
      void response.body?.cancel().catch(() => undefined);
      throw new EnvironmentConnectionError(environmentConnectionErrorCodes.gatewayResponseInvalid);
    }
    const parsed = revocationResponseSchema.safeParse(await readBoundedJson(response));
    if (!parsed.success) {
      throw new EnvironmentConnectionError(environmentConnectionErrorCodes.gatewayResponseInvalid);
    }
    return parsed.data;
  }

  async revokeProjectConnections(
    projectId: string,
    agentIds: string[],
  ): Promise<{ terminated: number; pending: number }> {
    if (!this.binding) {
      throw new EnvironmentConnectionError(environmentConnectionErrorCodes.gatewayUnavailable);
    }

    let response: Response;
    try {
      response = await this.binding.fetch(ENVIRONMENT_GATEWAY_PROJECT_REVOCATION_ENDPOINT, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          "x-paca-environment-gateway-protocol": ENVIRONMENT_GATEWAY_PROTOCOL,
        },
        body: JSON.stringify({
          protocolVersion: ENVIRONMENT_GATEWAY_PROTOCOL,
          projectId,
          agentIds,
        }),
      });
    } catch {
      throw new EnvironmentConnectionError(environmentConnectionErrorCodes.gatewayUnavailable);
    }

    if (response.status < 200 || response.status >= 300) {
      void response.body?.cancel().catch(() => undefined);
      throw new EnvironmentConnectionError(environmentConnectionErrorCodes.gatewayUnavailable);
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (contentType !== "application/json") {
      void response.body?.cancel().catch(() => undefined);
      throw new EnvironmentConnectionError(environmentConnectionErrorCodes.gatewayResponseInvalid);
    }
    const parsed = revocationResponseSchema.safeParse(await readBoundedJson(response));
    if (!parsed.success) {
      throw new EnvironmentConnectionError(environmentConnectionErrorCodes.gatewayResponseInvalid);
    }
    return parsed.data;
  }

  async revokeEnvironmentConnections(
    projectId: string,
    environmentId: string,
    agentIds: string[],
  ): Promise<{ terminated: number; pending: number }> {
    if (!this.binding) {
      throw new EnvironmentConnectionError(environmentConnectionErrorCodes.gatewayUnavailable);
    }

    let response: Response;
    try {
      response = await this.binding.fetch(ENVIRONMENT_GATEWAY_RESOURCE_REVOCATION_ENDPOINT, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          "x-paca-environment-gateway-protocol": ENVIRONMENT_GATEWAY_PROTOCOL,
        },
        body: JSON.stringify({
          protocolVersion: ENVIRONMENT_GATEWAY_PROTOCOL,
          projectId,
          environmentId,
          agentIds,
        }),
      });
    } catch {
      throw new EnvironmentConnectionError(environmentConnectionErrorCodes.gatewayUnavailable);
    }

    if (response.status < 200 || response.status >= 300) {
      void response.body?.cancel().catch(() => undefined);
      throw new EnvironmentConnectionError(environmentConnectionErrorCodes.gatewayUnavailable);
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (contentType !== "application/json") {
      void response.body?.cancel().catch(() => undefined);
      throw new EnvironmentConnectionError(environmentConnectionErrorCodes.gatewayResponseInvalid);
    }
    const parsed = revocationResponseSchema.safeParse(await readBoundedJson(response));
    if (!parsed.success) {
      throw new EnvironmentConnectionError(environmentConnectionErrorCodes.gatewayResponseInvalid);
    }
    return parsed.data;
  }
}
