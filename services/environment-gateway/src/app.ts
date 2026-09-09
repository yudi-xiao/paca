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
import { accessTokenFromRequest, signTicket, TicketError, verifyTicket } from "./ticket";

const MAX_ISSUE_REQUEST_BYTES = 16 * 1024;
const PRIVATE_ISSUE_PATH = "/v1/connections";
const PRIVATE_REVOCATION_PATH = "/v1/revocations/agent";
const PRIVATE_PROJECT_REVOCATION_PATH = "/v1/revocations/project";

export type GatewayBindings = Pick<
  Env,
  "AGENT_CONNECTIONS" | "CONNECTION_TICKETS" | "ENVIRONMENT" | "PUBLIC_ORIGIN" | "SANDBOXES"
> & { CONNECTION_TICKET_SECRET: string };

export type GatewayDependencies = {
  now: () => Date;
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

function codeResponse(code: string, status: 400 | 401 | 403 | 404 | 409 | 422 | 500 | 503) {
  return Response.json(
    { code },
    {
      status,
      headers: { "cache-control": "no-store" },
    },
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
    if (!provider.supports(claims)) return codeResponse("GATEWAY_PROVIDER_UNAVAILABLE", 503);

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
    if (!provider.supports(claims)) return codeResponse("GATEWAY_PROVIDER_UNAVAILABLE", 503);
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
      } catch {
        if (registered) {
          await dependencies
            .unregisterConnection(context.env, claims.agentId, claims.jti)
            .catch(() => undefined);
        } else if (terminalOpened) {
          await provider.terminate(connection, sessionId).catch(() => undefined);
        }
        console.error(
          JSON.stringify({
            level: "error",
            message: "environment.provider.failed",
            requestId: claims.jti,
            environmentId: claims.environmentId,
            backend: claims.backend,
            operationMode: claims.operationMode,
          }),
        );
        return codeResponse("GATEWAY_PROVIDER_FAILED", 503);
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
      return Response.json(await provider.status(claims), {
        headers: { "cache-control": "no-store" },
      });
    } catch {
      console.error(
        JSON.stringify({
          level: "error",
          message: "environment.provider.failed",
          requestId: claims.jti,
          environmentId: claims.environmentId,
          backend: claims.backend,
          operationMode: claims.operationMode,
        }),
      );
      return codeResponse("GATEWAY_PROVIDER_FAILED", 503);
    }
  });

  app.notFound(() => codeResponse("NOT_FOUND", 404));
  return app;
}
