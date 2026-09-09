import {
  getSandbox,
  isDurableObjectCodeUpdateReset,
  isPlatformTransientError,
  proxyTerminal,
} from "@cloudflare/sandbox";

import type { TicketClaims } from "./protocol";
import {
  ClassifiedEnvironmentProviderError,
  classifyEnvironmentProviderFailure,
  type EnvironmentProviderOperation,
} from "./provider-failure";

export type EnvironmentStatus = {
  environmentId: string;
  processes: Array<{
    id: string;
    pid?: number;
    status: string;
    startTime: string;
    endTime?: string;
    exitCode?: number;
    sessionId?: string;
  }>;
};

export interface EnvironmentProvider {
  supports(claims: TicketClaims): boolean;
  prepare(claims: TicketClaims): Promise<void>;
  status(claims: TicketClaims): Promise<EnvironmentStatus>;
  terminal(claims: TicketClaims, sessionId: string, request: Request): Promise<Response>;
  terminate(
    input: { backend: TicketClaims["backend"]; reference: string },
    sessionId: string,
  ): Promise<void>;
}

const SANDBOX_ID = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const DEFAULT_RETRY_AFTER_MS = 500;

function isReadOnlyOperation(operation: EnvironmentProviderOperation): boolean {
  return operation === "prepare" || operation === "status";
}

function normalizeEnvironmentProviderFailure(
  error: unknown,
  operation: EnvironmentProviderOperation,
): ClassifiedEnvironmentProviderError {
  const failure = classifyEnvironmentProviderFailure(error, operation);
  if (failure.code !== "GATEWAY_PROVIDER_FAILED") {
    return new ClassifiedEnvironmentProviderError(failure);
  }
  if (isDurableObjectCodeUpdateReset(error)) {
    return new ClassifiedEnvironmentProviderError({
      code: "GATEWAY_PROVIDER_TRANSIENT",
      retryable: true,
      retryAfterMs: DEFAULT_RETRY_AFTER_MS,
      retryInRequest: false,
    });
  }
  if (isPlatformTransientError(error)) {
    return new ClassifiedEnvironmentProviderError(
      isReadOnlyOperation(operation)
        ? {
            code: "GATEWAY_PROVIDER_TRANSIENT",
            retryable: true,
            retryAfterMs: DEFAULT_RETRY_AFTER_MS,
          }
        : { code: "GATEWAY_PROVIDER_OPERATION_UNCERTAIN", retryable: false },
    );
  }
  return new ClassifiedEnvironmentProviderError(failure);
}

async function providerCall<T>(
  operation: EnvironmentProviderOperation,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw normalizeEnvironmentProviderFailure(error, operation);
  }
}

export class CloudflareSandboxProvider implements EnvironmentProvider {
  constructor(private readonly env: Pick<Env, "SANDBOXES">) {}

  supports(claims: TicketClaims): boolean {
    return claims.backend === "cloudflare-sandbox" && SANDBOX_ID.test(claims.reference);
  }

  private sandbox(claims: TicketClaims) {
    return getSandbox(this.env.SANDBOXES, claims.reference, {
      sleepAfter: "10m",
      containerTimeouts: {
        instanceGetTimeoutMS: 30_000,
        portReadyTimeoutMS: 90_000,
        waitIntervalMS: 300,
      },
      labels: {
        environmentId: claims.environmentId,
        projectId: claims.projectId,
        workload: "paca-environment",
      },
    });
  }

  async prepare(claims: TicketClaims): Promise<void> {
    await providerCall("prepare", () => this.sandbox(claims).listProcesses()).then(() => undefined);
  }

  async status(claims: TicketClaims): Promise<EnvironmentStatus> {
    const processes = await providerCall("status", () => this.sandbox(claims).listProcesses());
    return {
      environmentId: claims.environmentId,
      processes: processes.slice(0, 1000).map((process) => ({
        id: process.id,
        ...(process.pid === undefined ? {} : { pid: process.pid }),
        status: process.status,
        startTime: process.startTime.toISOString(),
        ...(process.endTime === undefined ? {} : { endTime: process.endTime.toISOString() }),
        ...(process.exitCode === undefined ? {} : { exitCode: process.exitCode }),
        ...(process.sessionId === undefined ? {} : { sessionId: process.sessionId }),
      })),
    };
  }

  async terminal(claims: TicketClaims, sessionId: string, request: Request): Promise<Response> {
    return providerCall("terminal", () =>
      proxyTerminal(this.sandbox(claims), sessionId, request, {
        cols: 120,
        rows: 30,
      }),
    );
  }

  async terminate(
    input: { backend: TicketClaims["backend"]; reference: string },
    sessionId: string,
  ): Promise<void> {
    if (input.backend !== "cloudflare-sandbox" || !SANDBOX_ID.test(input.reference)) {
      throw new Error("GATEWAY_PROVIDER_UNAVAILABLE");
    }
    const result = await providerCall("terminate", () =>
      getSandbox(this.env.SANDBOXES, input.reference, {
        sleepAfter: "10m",
        containerTimeouts: {
          instanceGetTimeoutMS: 30_000,
          portReadyTimeoutMS: 90_000,
          waitIntervalMS: 300,
        },
      }).deleteSession(sessionId),
    );
    if (!result.success) throw new Error("GATEWAY_SESSION_TERMINATION_FAILED");
  }
}
