import { Hono } from "hono";
import {
  type ActiveEnvironmentConnection,
  connectionPath,
  connectionProtocol,
  connectionResponseSchema,
  gatewayProtocol,
  ISSUED_CONNECTION_TTL_SECONDS,
  issueRequestSchema,
  MAX_AUTHORIZATION_TTL_SECONDS,
  privateGatewayOrigin,
  revokeAgentConnectionsRequestSchema,
  revokeProjectConnectionsRequestSchema,
  type TicketClaims,
} from "./protocol";
import type { EnvironmentProvider } from "./provider";
import {
  classifyEnvironmentProviderFailure,
  type EnvironmentProviderFailure,
  type EnvironmentProviderOperation,
} from "./provider-failure";
import { accessTokenFromRequest, signTicket, TicketError, verifyTicket } from "./ticket";

const MAX_ISSUE_REQUEST_BYTES = 16 * 1024;
const PRIVATE_ISSUE_PATH = "/v1/connections";
const PRIVATE_REVOCATION_PATH = "/v1/revocations/agent";
const PRIVATE_PROJECT_REVOCATION_PATH = "/v1/revocations/project";
const MAX_PROVIDER_ATTEMPTS = 3;

export type GatewayBindings = Pick<
  Env,
  "AGENT_CONNECTIONS" | "CONNECTION_TICKETS" | "ENVIRONMENT" | "PUBLIC_ORIGIN" | "SANDBOXES"
> & { CONNECTION_TICKET_SECRET: string };

export type GatewayDependencies = {
  now: () => Date;
  wait: (milliseconds: number) => Promise<void>;
  provider: (env: GatewayBindings) => EnvironmentProvider;
  consumeTicket: (env: GatewayBindings, ticketId: string, expiresAtMs: number) => Promise<boolean>;
  registerConnection: (
    env: GatewayBindings,
    connection: ActiveEnvironmentConnection,
  ) => Promise<boolean>;
  isTicketAuthorized: (
    env: GatewayBindings,
    agentId: string,
    projectId: string,
    ticketIssuedAtMs: number,
  ) => Promise<boolean>;
  unregisterConnection: (
    env: GatewayBindings,
    agentId: string,
    connectionId: string,
  ) => Promise<void>;
  revokeAgentConnections: (
    env: GatewayBindings,
    agentId: string,
  ) => Promise<{
    terminated: number;
    pending: number;
  }>;
  revokeProjectConnections: (
    env: GatewayBindings,
    projectId: string,
    agentIds: string[],
  ) => Promise<{
    terminated: number;
    pending: number;
  }>;
};

function publicOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      value === url.origin
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

async function boundedJson(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const size = Number(declaredLength);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ISSUE_REQUEST_BYTES) {
      throw new Error("REQUEST_INVALID");
    }
  }
  if (!request.body) throw new Error("REQUEST_INVALID");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_ISSUE_REQUEST_BYTES) {
        await reader.cancel();
        throw new Error("REQUEST_INVALID");
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
    throw new Error("REQUEST_INVALID");
  }
}

function codeResponse(code: string, status: 400 | 401 | 403 | 404 | 409 | 422 | 500 | 502 | 503) {
  return Response.json(
    { code },
    {
      status,
      headers: { "cache-control": "no-store" },
    },
  );
}

class ProviderCallFailure extends Error {
  constructor(
    readonly failure: EnvironmentProviderFailure,
    readonly attempts: number,
  ) {
    super(failure.code);
    this.name = "ProviderCallFailure";
  }
}

async function callReadOnlyProvider<T>(
  dependencies: GatewayDependencies,
  operation: "prepare" | "status",
  call: () => Promise<T>,
): Promise<{ value: T; attempts: number }> {
  for (let attempts = 1; attempts <= MAX_PROVIDER_ATTEMPTS; attempts += 1) {
    try {
      return { value: await call(), attempts };
    } catch (error) {
      const failure = classifyEnvironmentProviderFailure(error, operation);
      if (
        !failure.retryable ||
        failure.retryInRequest === false ||
        attempts === MAX_PROVIDER_ATTEMPTS
      ) {
        throw new ProviderCallFailure(failure, attempts);
      }
      await dependencies.wait(failure.retryAfterMs ?? 500);
    }
  }
  throw new Error("GATEWAY_PROVIDER_RETRY_INVARIANT");
}

function providerFailureResponse(
  failure: EnvironmentProviderFailure,
  attempts: number,
  operation: EnvironmentProviderOperation,
  claims: TicketClaims,
): Response {
  console.error(
    JSON.stringify({
      level: "error",
      message: "environment.provider.failed",
      requestId: claims.jti,
      environmentId: claims.environmentId,
      backend: claims.backend,
      operation,
      code: failure.code,
      retryable: failure.retryable,
      attempts,
    }),
  );
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  if (failure.retryable && failure.retryAfterMs !== undefined) {
    headers.set("retry-after", String(Math.max(1, Math.ceil(failure.retryAfterMs / 1_000))));
  }
  return Response.json(
    {
      code: failure.code,
      retryable: failure.retryable,
      ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
      attempts,
    },
    { status: failure.retryable ? 503 : 502, headers },
  );
}

function unsupportedProviderResponse(): Response {
  return Response.json(
    {
      code: "GATEWAY_PROVIDER_UNSUPPORTED",
      retryable: false,
      attempts: 1,
    },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}

function sanitizedTerminalRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  headers.delete("sec-websocket-protocol");
  return new Request(request.url, { method: "GET", headers });
}

function claimsFromIssue(
  request: ReturnType<typeof issueRequestSchema.parse>,
  now: Date,
): TicketClaims | null {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const authorizationExpiry = Math.floor(Date.parse(request.authorizationExpiresAt) / 1000);
  if (authorizationExpiry > nowSeconds + MAX_AUTHORIZATION_TTL_SECONDS) return null;
  const expiresAt = Math.min(nowSeconds + ISSUED_CONNECTION_TTL_SECONDS, authorizationExpiry);
  if (expiresAt <= nowSeconds) return null;
  return {
    version: 1,
    jti: request.requestId,
    environmentId: request.environment.id,
    organizationId: request.environment.organizationId,
    projectId: request.environment.projectId,
    backend: request.environment.backend,
    reference: request.environment.reference,
    operationMode: request.operationMode,
    agentId: request.actor.agentId,
    hostId: request.actor.hostId,
    issuedAt: nowSeconds,
    issuedAtMs: now.getTime(),
    expiresAt,
    authorizationExpiresAt: authorizationExpiry,
  };
}

export function createGatewayApp(
  dependencies: GatewayDependencies,
): Hono<{ Bindings: GatewayBindings }> {
  const app = new Hono<{ Bindings: GatewayBindings }>();

  app.get("/health", (context) =>
    context.json({ status: "ok", environment: context.env.ENVIRONMENT }, 200, {
      "cache-control": "no-store",
    }),
  );

  app.post(PRIVATE_ISSUE_PATH, async (context) => {
    const requestUrl = new URL(context.req.url);
    if (
      requestUrl.origin !== privateGatewayOrigin ||
      context.req.header("x-paca-environment-gateway-protocol") !== gatewayProtocol ||
      context.req.header("content-type")?.split(";", 1)[0]?.trim() !== "application/json"
    ) {
      return codeResponse("GATEWAY_PRIVATE_ROUTE_REQUIRED", 404);
    }
    const origin = publicOrigin(context.env.PUBLIC_ORIGIN);
    if (!origin) return codeResponse("GATEWAY_CONFIG_INVALID", 503);

    let issueRequest: ReturnType<typeof issueRequestSchema.parse>;
    try {
      issueRequest = issueRequestSchema.parse(await boundedJson(context.req.raw));
    } catch {
      return codeResponse("GATEWAY_REQUEST_INVALID", 400);
    }
    const claims = claimsFromIssue(issueRequest, dependencies.now());
    if (!claims) return codeResponse("GATEWAY_AUTHORIZATION_EXPIRED", 403);
    const provider = dependencies.provider(context.env);
    if (!provider.supports(claims)) return unsupportedProviderResponse();

    try {
      const connectionOrigin =
        claims.operationMode === "execute" ? origin.replace(/^https:/u, "wss:") : origin;
      const response = connectionResponseSchema.parse({
        protocolVersion: connectionProtocol,
        requestId: claims.jti,
        environmentId: claims.environmentId,
        operationMode: claims.operationMode,
        transport: claims.operationMode === "execute" ? "websocket" : "http",
        url: `${connectionOrigin}${connectionPath}`,
        accessToken: await signTicket(claims, context.env.CONNECTION_TICKET_SECRET),
        expiresAt: new Date(claims.expiresAt * 1000).toISOString(),
      });
      return Response.json(response, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      return codeResponse(
        error instanceof TicketError && error.code === "TICKET_CONFIG_INVALID"
          ? "GATEWAY_CONFIG_INVALID"
          : "GATEWAY_RESPONSE_INVALID",
        503,
      );
    }
  });

  app.post(PRIVATE_REVOCATION_PATH, async (context) => {
    const requestUrl = new URL(context.req.url);
    if (
      requestUrl.origin !== privateGatewayOrigin ||
      context.req.header("x-paca-environment-gateway-protocol") !== gatewayProtocol ||
      context.req.header("content-type")?.split(";", 1)[0]?.trim() !== "application/json"
    ) {
      return codeResponse("GATEWAY_PRIVATE_ROUTE_REQUIRED", 404);
    }
    let request: ReturnType<typeof revokeAgentConnectionsRequestSchema.parse>;
    try {
      request = revokeAgentConnectionsRequestSchema.parse(await boundedJson(context.req.raw));
    } catch {
      return codeResponse("GATEWAY_REQUEST_INVALID", 400);
    }
    try {
      const result = await dependencies.revokeAgentConnections(context.env, request.agentId);
      return Response.json(result, {
        status: result.pending > 0 ? 202 : 200,
        headers: { "cache-control": "no-store" },
      });
    } catch {
      console.error(
        JSON.stringify({
          level: "error",
          message: "environment.revocation.failed",
          agentId: request.agentId,
        }),
      );
      return codeResponse("GATEWAY_REVOCATION_FAILED", 503);
    }
  });

  app.post(PRIVATE_PROJECT_REVOCATION_PATH, async (context) => {
    const requestUrl = new URL(context.req.url);
    if (
      requestUrl.origin !== privateGatewayOrigin ||
      context.req.header("x-paca-environment-gateway-protocol") !== gatewayProtocol ||
      context.req.header("content-type")?.split(";", 1)[0]?.trim() !== "application/json"
    ) {
      return codeResponse("GATEWAY_PRIVATE_ROUTE_REQUIRED", 404);
    }
    let request: ReturnType<typeof revokeProjectConnectionsRequestSchema.parse>;
    try {
      request = revokeProjectConnectionsRequestSchema.parse(await boundedJson(context.req.raw));
    } catch {
      return codeResponse("GATEWAY_REQUEST_INVALID", 400);
    }
    try {
      const result = await dependencies.revokeProjectConnections(context.env, request.projectId, [
        ...new Set(request.agentIds),
      ]);
      return Response.json(result, {
        status: result.pending > 0 ? 202 : 200,
        headers: { "cache-control": "no-store" },
      });
    } catch {
      console.error(
        JSON.stringify({
          level: "error",
          message: "environment.project_revocation.failed",
          projectId: request.projectId,
          agentCount: request.agentIds.length,
        }),
      );
      return codeResponse("GATEWAY_REVOCATION_FAILED", 503);
    }
  });

  app.all(connectionPath, async (context) => {
    const origin = publicOrigin(context.env.PUBLIC_ORIGIN);
    if (!origin || new URL(context.req.url).origin !== origin) {
      return codeResponse("GATEWAY_PUBLIC_ROUTE_REQUIRED", 404);
    }
    const token = accessTokenFromRequest(context.req.raw);
    if (!token) return codeResponse("GATEWAY_TICKET_REQUIRED", 401);

    let claims: TicketClaims;
    try {
      claims = await verifyTicket(token, context.env.CONNECTION_TICKET_SECRET, dependencies.now());
    } catch {
      return codeResponse("GATEWAY_TICKET_INVALID", 401);
    }
    const provider = dependencies.provider(context.env);
    if (!provider.supports(claims)) return unsupportedProviderResponse();
    if (
      !(await dependencies.isTicketAuthorized(
        context.env,
        claims.agentId,
        claims.projectId,
        claims.issuedAtMs,
      ))
    ) {
      return codeResponse("GATEWAY_TICKET_REVOKED", 401);
    }

    if (claims.operationMode === "execute") {
      if (
        context.req.method === "POST" &&
        context.req.header("content-type")?.split(";", 1)[0]?.trim() === "application/json"
      ) {
        let body: unknown;
        try {
          body = await boundedJson(context.req.raw);
        } catch {
          return codeResponse("GATEWAY_REQUEST_INVALID", 400);
        }
        if (
          typeof body !== "object" ||
          body === null ||
          Array.isArray(body) ||
          Object.keys(body).length !== 1 ||
          !("action" in body) ||
          body.action !== "prepare"
        ) {
          return codeResponse("GATEWAY_PREPARE_REQUEST_INVALID", 400);
        }
        try {
          const prepared = await callReadOnlyProvider(dependencies, "prepare", () =>
            provider.prepare(claims),
          );
          return Response.json(
            { status: "ready", environmentId: claims.environmentId },
            {
              headers: {
                "cache-control": "no-store",
                "x-paca-provider-attempts": String(prepared.attempts),
              },
            },
          );
        } catch (error) {
          if (error instanceof ProviderCallFailure) {
            return providerFailureResponse(error.failure, error.attempts, "prepare", claims);
          }
          throw error;
        }
      }
      if (
        context.req.method !== "GET" ||
        context.req.header("upgrade")?.toLowerCase() !== "websocket"
      ) {
        return codeResponse("GATEWAY_WEBSOCKET_REQUIRED", 422);
      }
      if (!(await dependencies.consumeTicket(context.env, claims.jti, claims.expiresAt * 1000))) {
        return codeResponse("GATEWAY_TICKET_REPLAYED", 409);
      }
      const sessionId = `paca-${claims.jti}`;
      const connection: ActiveEnvironmentConnection = {
        connectionId: claims.jti,
        agentId: claims.agentId,
        environmentId: claims.environmentId,
        projectId: claims.projectId,
        backend: claims.backend,
        reference: claims.reference,
        sessionId,
        ticketIssuedAtMs: claims.issuedAtMs,
        authorizationExpiresAtMs: claims.authorizationExpiresAt * 1000,
      };
      let terminalOpened = false;
      let registered = false;
      try {
        const terminalResponse = await provider.terminal(
          claims,
          sessionId,
          sanitizedTerminalRequest(context.req.raw),
        );
        terminalOpened = true;
        registered = await dependencies.registerConnection(context.env, connection);
        if (!registered) {
          await provider.terminate(connection, sessionId);
          return codeResponse("GATEWAY_TICKET_REVOKED", 401);
        }
        return terminalResponse;
      } catch (error) {
        if (registered) {
          await dependencies
            .unregisterConnection(context.env, claims.agentId, claims.jti)
            .catch(() => undefined);
        } else if (terminalOpened) {
          await provider.terminate(connection, sessionId).catch(() => undefined);
        }
        return providerFailureResponse(
          classifyEnvironmentProviderFailure(error, "terminal"),
          1,
          "terminal",
          claims,
        );
      }
    }

    if (
      context.req.method !== "POST" ||
      context.req.header("content-type")?.split(";", 1)[0]?.trim() !== "application/json"
    ) {
      return codeResponse("GATEWAY_STATUS_REQUEST_REQUIRED", 422);
    }
    let body: unknown;
    try {
      body = await boundedJson(context.req.raw);
    } catch {
      return codeResponse("GATEWAY_REQUEST_INVALID", 400);
    }
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !("action" in body) ||
      body.action !== "status"
    ) {
      return codeResponse("GATEWAY_STATUS_REQUEST_INVALID", 400);
    }
    try {
      const status = await callReadOnlyProvider(dependencies, "status", () =>
        provider.status(claims),
      );
      return Response.json(status.value, {
        headers: {
          "cache-control": "no-store",
          "x-paca-provider-attempts": String(status.attempts),
        },
      });
    } catch (error) {
      if (error instanceof ProviderCallFailure) {
        return providerFailureResponse(error.failure, error.attempts, "status", claims);
      }
      throw error;
    }
  });

  app.notFound(() => codeResponse("NOT_FOUND", 404));
  return app;
}
