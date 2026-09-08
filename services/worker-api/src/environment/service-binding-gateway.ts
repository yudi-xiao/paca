import * as z from "zod";

import {
  type EnvironmentConnection,
  EnvironmentConnectionError,
  type EnvironmentConnectionGateway,
  environmentConnectionErrorCodes,
  environmentConnectionProtocol,
} from "./service";

const ENVIRONMENT_GATEWAY_ENDPOINT = "https://environment-gateway.internal/v1/connections";
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
      void response.body?.cancel().catch(() => undefined);
      throw new EnvironmentConnectionError(environmentConnectionErrorCodes.gatewayUnavailable);
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
}
