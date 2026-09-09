import * as z from "zod";

export const gatewayProtocol = "paca.environment.gateway.v1" as const;
export const connectionProtocol = "paca.environment.connection.v1" as const;
export const privateGatewayOrigin = "https://environment-gateway.internal";
export const connectionPath = "/v1/connect";
export const MAX_CONNECTION_TTL_SECONDS = 60;
export const ISSUED_CONNECTION_TTL_SECONDS = 55;
export const MAX_AUTHORIZATION_TTL_SECONDS = 15 * 60;

export const backendSchema = z.enum([
  "cloudflare-sandbox",
  "cloudflare-computer",
  "legacy-agent-runner",
]);
export type EnvironmentBackend = z.infer<typeof backendSchema>;

export const operationModeSchema = z.enum(["read", "execute"]);
export type OperationMode = z.infer<typeof operationModeSchema>;

export const issueRequestSchema = z
  .object({
    protocolVersion: z.literal(gatewayProtocol),
    requestId: z.uuid(),
    environment: z
      .object({
        id: z.uuid(),
        organizationId: z.string().trim().min(1).max(255),
        projectId: z.uuid(),
        backend: backendSchema,
        reference: z.string().trim().min(1).max(500),
      })
      .strict(),
    operationMode: operationModeSchema,
    actor: z
      .object({
        type: z.literal("agent"),
        agentId: z.string().trim().min(1).max(255),
        hostId: z.string().trim().min(1).max(255),
      })
      .strict(),
    authorizationExpiresAt: z.iso.datetime(),
  })
  .strict();
export type IssueRequest = z.infer<typeof issueRequestSchema>;

export const ticketClaimsSchema = z
  .object({
    version: z.literal(1),
    jti: z.uuid(),
    environmentId: z.uuid(),
    organizationId: z.string().trim().min(1).max(255),
    projectId: z.uuid(),
    backend: backendSchema,
    reference: z.string().trim().min(1).max(500),
    operationMode: operationModeSchema,
    agentId: z.string().trim().min(1).max(255),
    hostId: z.string().trim().min(1).max(255),
    issuedAt: z.number().int().nonnegative(),
    issuedAtMs: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    authorizationExpiresAt: z.number().int().positive(),
  })
  .strict();
export type TicketClaims = z.infer<typeof ticketClaimsSchema>;

export const activeEnvironmentConnectionSchema = z
  .object({
    connectionId: z.uuid(),
    agentId: z.string().trim().min(1).max(255),
    environmentId: z.uuid(),
    projectId: z.uuid(),
    backend: backendSchema,
    reference: z.string().trim().min(1).max(500),
    sessionId: z.string().regex(/^paca-[0-9a-f-]{36}$/u),
    ticketIssuedAtMs: z.number().int().positive(),
    authorizationExpiresAtMs: z.number().int().positive(),
  })
  .strict();
export type ActiveEnvironmentConnection = z.infer<typeof activeEnvironmentConnectionSchema>;

export const revokeAgentConnectionsRequestSchema = z
  .object({
    protocolVersion: z.literal(gatewayProtocol),
    agentId: z.string().trim().min(1).max(255),
  })
  .strict();

export const revokeProjectConnectionsRequestSchema = z
  .object({
    protocolVersion: z.literal(gatewayProtocol),
    projectId: z.uuid(),
    agentIds: z.array(z.string().trim().min(1).max(255)).min(1).max(100),
  })
  .strict();

export const connectionResponseSchema = z
  .object({
    protocolVersion: z.literal(connectionProtocol),
    requestId: z.uuid(),
    environmentId: z.uuid(),
    operationMode: operationModeSchema,
    transport: z.enum(["http", "websocket"]),
    url: z.url(),
    accessToken: z.string().min(1).max(4096),
    expiresAt: z.iso.datetime(),
  })
  .strict();
