import { type GatewayProviderFailureCode, gatewayProviderFailureCodes } from "./protocol";

const MIN_RETRY_AFTER_MS = 100;
const MAX_RETRY_AFTER_MS = 10_000;
const DEFAULT_RETRY_AFTER_MS = 500;

export type EnvironmentProviderOperation = "prepare" | "status" | "terminal" | "terminate";

export type EnvironmentProviderFailure = {
  code: GatewayProviderFailureCode;
  retryable: boolean;
  retryAfterMs?: number;
  retryInRequest?: boolean;
};

export class ClassifiedEnvironmentProviderError extends Error {
  constructor(readonly failure: EnvironmentProviderFailure) {
    super(failure.code);
    this.name = "ClassifiedEnvironmentProviderError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function retryAfterMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, Math.round(value)));
}

function isReadOnlyOperation(operation: EnvironmentProviderOperation): boolean {
  return operation === "prepare" || operation === "status";
}

export function classifyEnvironmentProviderFailure(
  error: unknown,
  operation: EnvironmentProviderOperation,
): EnvironmentProviderFailure {
  if (error instanceof ClassifiedEnvironmentProviderError) return error.failure;

  const input = record(error);
  const context = record(input?.context);
  if (input?.code === "CONTAINER_UNAVAILABLE" && context?.retryable === true) {
    const capacity =
      context.reason === "no_container_instance_available" ||
      context.reason === "max_container_instances_exceeded";
    return {
      code: capacity ? gatewayProviderFailureCodes.capacity : gatewayProviderFailureCodes.starting,
      retryable: true,
      retryAfterMs: retryAfterMs(context.retryAfterMs),
    };
  }

  if (input?.code === "OPERATION_INTERRUPTED") {
    const safeToRetry =
      isReadOnlyOperation(operation) || (context?.admitted === false && context.retryable === true);
    return safeToRetry
      ? {
          code: gatewayProviderFailureCodes.transient,
          retryable: true,
          retryAfterMs: DEFAULT_RETRY_AFTER_MS,
        }
      : { code: gatewayProviderFailureCodes.operationUncertain, retryable: false };
  }

  if (input?.code === "RPC_TRANSPORT_ERROR") {
    return isReadOnlyOperation(operation)
      ? {
          code: gatewayProviderFailureCodes.transient,
          retryable: true,
          retryAfterMs: DEFAULT_RETRY_AFTER_MS,
        }
      : { code: gatewayProviderFailureCodes.operationUncertain, retryable: false };
  }

  return { code: gatewayProviderFailureCodes.failed, retryable: false };
}
