export const environmentConnectionProtocol = "paca.environment.connection.v1" as const;
export const ENVIRONMENT_CONNECTION_MAX_TTL_MS = 60_000;

export type EnvironmentOperationMode = "read" | "execute";
export type EnvironmentBackend =
  | "cloudflare-sandbox"
  | "cloudflare-computer"
  | "legacy-agent-runner";

export type EnvironmentScope = {
  environmentId: string;
  organizationId: string;
  projectId: string;
  backend: EnvironmentBackend;
  gatewayReference: string;
};

export type EnvironmentConnection = {
  protocolVersion: typeof environmentConnectionProtocol;
  requestId: string;
  environmentId: string;
  operationMode: EnvironmentOperationMode;
  transport: "http" | "websocket";
  url: string;
  accessToken: string;
  expiresAt: Date;
};

export type EnvironmentScopeRepository = {
  find(environmentId: string): Promise<EnvironmentScope | null>;
};

export type EnvironmentConnectionGateway = {
  issue(input: {
    requestId: string;
    scope: EnvironmentScope;
    operationMode: EnvironmentOperationMode;
    actor: { agentId: string; hostId: string };
    authorizationExpiresAt: Date;
  }): Promise<EnvironmentConnection>;
};

export const environmentConnectionErrorCodes = {
  authorizationExpired: "AGENT_ENVIRONMENT_AUTHORIZATION_EXPIRED",
  gatewayResponseInvalid: "AGENT_ENVIRONMENT_GATEWAY_RESPONSE_INVALID",
  gatewayUnavailable: "AGENT_ENVIRONMENT_GATEWAY_UNAVAILABLE",
  providerFailed: "AGENT_ENVIRONMENT_PROVIDER_FAILED",
  providerUnsupported: "AGENT_ENVIRONMENT_PROVIDER_UNSUPPORTED",
  scopeMismatch: "AGENT_ENVIRONMENT_SCOPE_MISMATCH",
} as const;

export type EnvironmentConnectionErrorCode =
  (typeof environmentConnectionErrorCodes)[keyof typeof environmentConnectionErrorCodes];

export class EnvironmentConnectionError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    readonly code: EnvironmentConnectionErrorCode,
    options: { retryable?: boolean; retryAfterMs?: number } = {},
  ) {
    super(code);
    this.name = "EnvironmentConnectionError";
    this.retryable =
      options.retryable ?? code === environmentConnectionErrorCodes.gatewayUnavailable;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

function isSecureConnectionUrl(
  value: string,
  transport: EnvironmentConnection["transport"],
): boolean {
  try {
    const url = new URL(value);
    const expectedProtocol = transport === "websocket" ? "wss:" : "https:";
    return (
      url.protocol === expectedProtocol &&
      url.origin !== "null" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export class EnvironmentConnectionService {
  constructor(
    private readonly repository: EnvironmentScopeRepository,
    private readonly gateway: EnvironmentConnectionGateway,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async connect(input: {
    requestId: string;
    organizationId: string;
    projectId: string;
    environmentId: string;
    operationMode: EnvironmentOperationMode;
    actor: { agentId: string; hostId: string };
    authorizationExpiresAt: Date;
  }): Promise<EnvironmentConnection> {
    const now = this.now();
    if (input.authorizationExpiresAt.getTime() <= now.getTime()) {
      throw new EnvironmentConnectionError(environmentConnectionErrorCodes.authorizationExpired);
    }

    const scope = await this.repository.find(input.environmentId);
    if (
      !scope ||
      scope.organizationId !== input.organizationId ||
      scope.projectId !== input.projectId
    ) {
      throw new EnvironmentConnectionError(environmentConnectionErrorCodes.scopeMismatch);
    }

    const connection = await this.gateway.issue({
      requestId: input.requestId,
      scope,
      operationMode: input.operationMode,
      actor: input.actor,
      authorizationExpiresAt: input.authorizationExpiresAt,
    });
    const expiresAt = connection.expiresAt.getTime();
    const latestAllowedExpiry = Math.min(
      input.authorizationExpiresAt.getTime(),
      now.getTime() + ENVIRONMENT_CONNECTION_MAX_TTL_MS,
    );
    if (
      connection.protocolVersion !== environmentConnectionProtocol ||
      connection.requestId !== input.requestId ||
      connection.environmentId !== input.environmentId ||
      connection.operationMode !== input.operationMode ||
      !isSecureConnectionUrl(connection.url, connection.transport) ||
      !connection.accessToken ||
      utf8Length(connection.accessToken) > 4_096 ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= now.getTime() ||
      expiresAt > latestAllowedExpiry
    ) {
      throw new EnvironmentConnectionError(environmentConnectionErrorCodes.gatewayResponseInvalid);
    }
    return connection;
  }
}
