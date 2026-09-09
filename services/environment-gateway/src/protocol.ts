import * as z from "zod";

export const gatewayProtocol = "paca.environment.gateway.v1" as const;
export const connectionProtocol = "paca.environment.connection.v1" as const;

export const gatewayProviderFailureCodes = {
  starting: "GATEWAY_PROVIDER_STARTING",
  capacity: "GATEWAY_PROVIDER_CAPACITY",
  transient: "GATEWAY_PROVIDER_TRANSIENT",
  operationUncertain: "GATEWAY_PROVIDER_OPERATION_UNCERTAIN",
  failed: "GATEWAY_PROVIDER_FAILED",
  unsupported: "GATEWAY_PROVIDER_UNSUPPORTED",
} as const;

export type GatewayProviderFailureCode =
  (typeof gatewayProviderFailureCodes)[keyof typeof gatewayProviderFailureCodes];

export const gatewayProviderFailureSchema = z
  .object({
    code: z.enum(gatewayProviderFailureCodes),
    retryable: z.boolean(),
    retryAfterMs: z.number().int().min(100).max(10_000).optional(),
    attempts: z.number().int().min(1).max(3),
  })
  .strict();
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

export const connectionActorSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("agent"),
      agentId: z.string().trim().min(1).max(255),
      hostId: z.string().trim().min(1).max(255),
    })
    .strict(),
  z
    .object({
      type: z.literal("user"),
      userId: z.string().trim().min(1).max(255),
    })
    .strict(),
]);
export type ConnectionActor = z.infer<typeof connectionActorSchema>;

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
    actor: connectionActorSchema,
    authorizationExpiresAt: z.iso.datetime(),
  })
  .strict();
export type IssueRequest = z.infer<typeof issueRequestSchema>;

const ticketClaimsBaseSchema = z.object({
  version: z.literal(1),
  jti: z.uuid(),
  environmentId: z.uuid(),
  organizationId: z.string().trim().min(1).max(255),
  projectId: z.uuid(),
  backend: backendSchema,
  reference: z.string().trim().min(1).max(500),
  operationMode: operationModeSchema,
  issuedAt: z.number().int().nonnegative(),
  issuedAtMs: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  authorizationExpiresAt: z.number().int().positive(),
});

export const ticketClaimsSchema = z.discriminatedUnion("actorType", [
  ticketClaimsBaseSchema
    .extend({
      actorType: z.literal("agent"),
      agentId: z.string().trim().min(1).max(255),
      hostId: z.string().trim().min(1).max(255),
    })
    .strict(),
  ticketClaimsBaseSchema
    .extend({
      actorType: z.literal("user"),
      userId: z.string().trim().min(1).max(255),
    })
    .strict(),
]);
export type TicketClaims = z.infer<typeof ticketClaimsSchema>;

const activeEnvironmentConnectionBaseSchema = z.object({
  connectionId: z.uuid(),
  environmentId: z.uuid(),
  projectId: z.uuid(),
  backend: backendSchema,
  reference: z.string().trim().min(1).max(500),
  sessionId: z.string().regex(/^paca-[0-9a-f-]{36}$/u),
  ticketIssuedAtMs: z.number().int().positive(),
  authorizationExpiresAtMs: z.number().int().positive(),
});

export const activeEnvironmentConnectionSchema = z.union([
  activeEnvironmentConnectionBaseSchema
    .extend({
      principalType: z.enum(["agent", "user"]),
      principalId: z.string().trim().min(1).max(255),
    })
    .strict(),
  // Existing Agent registry rows remain readable during a rolling deploy.
  activeEnvironmentConnectionBaseSchema
    .extend({ agentId: z.string().trim().min(1).max(255) })
    .strict(),
]);
export type ActiveEnvironmentConnection = z.infer<typeof activeEnvironmentConnectionSchema>;

export const revokeAgentConnectionsRequestSchema = z
  .object({
    protocolVersion: z.literal(gatewayProtocol),
    agentId: z.string().trim().min(1).max(255),
  })
  .strict();

export const revokeUserConnectionsRequestSchema = z
  .object({
    protocolVersion: z.literal(gatewayProtocol),
    userId: z.string().trim().min(1).max(255),
  })
  .strict();

export const revokeProjectConnectionsRequestSchema = z
  .object({
    protocolVersion: z.literal(gatewayProtocol),
    projectId: z.uuid(),
    agentIds: z.array(z.string().trim().min(1).max(255)).max(100).default([]),
    userIds: z.array(z.string().trim().min(1).max(255)).max(100).default([]),
  })
  .refine((value) => value.agentIds.length > 0 || value.userIds.length > 0)
  .refine((value) => value.agentIds.length + value.userIds.length <= 100)
  .strict();

export const revokeEnvironmentConnectionsRequestSchema = z
  .object({
    protocolVersion: z.literal(gatewayProtocol),
    projectId: z.uuid(),
    environmentId: z.uuid(),
    // An empty list is valid: archiving an Environment must still advance
    // its global ticket barrier before browser principals are introduced.
    agentIds: z.array(z.string().trim().min(1).max(255)).max(100).default([]),
    userIds: z.array(z.string().trim().min(1).max(255)).max(100).default([]),
  })
  .refine((value) => value.agentIds.length + value.userIds.length <= 100)
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
