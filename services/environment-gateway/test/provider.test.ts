import { describe, expect, it } from "vitest";

import { classifyEnvironmentProviderFailure } from "../src/provider-failure";

describe("environment provider failure classification", () => {
  it("distinguishes cold start from account capacity before an operation is admitted", () => {
    const starting = {
      code: "CONTAINER_UNAVAILABLE",
      message: "starting",
      context: { reason: "container_starting", retryable: true, retryAfterMs: 250 },
    };
    const capacity = {
      code: "CONTAINER_UNAVAILABLE",
      message: "capacity",
      context: { reason: "no_container_instance_available", retryable: true },
    };

    expect(classifyEnvironmentProviderFailure(starting, "terminal")).toEqual({
      code: "GATEWAY_PROVIDER_STARTING",
      retryable: true,
      retryAfterMs: 250,
    });
    expect(classifyEnvironmentProviderFailure(capacity, "terminal")).toEqual({
      code: "GATEWAY_PROVIDER_CAPACITY",
      retryable: true,
      retryAfterMs: 500,
    });
  });

  it("only retries a transport loss automatically for read-only operations", () => {
    const error = {
      code: "RPC_TRANSPORT_ERROR",
      message: "transport lost",
      context: {
        kind: "peer_closed",
        originalMessage: "peer closed",
        errorName: "Error",
      },
    };

    expect(classifyEnvironmentProviderFailure(error, "status")).toEqual({
      code: "GATEWAY_PROVIDER_TRANSIENT",
      retryable: true,
      retryAfterMs: 500,
    });
    expect(classifyEnvironmentProviderFailure(error, "terminal")).toEqual({
      code: "GATEWAY_PROVIDER_OPERATION_UNCERTAIN",
      retryable: false,
    });
  });

  it("does not retry an interrupted mutating operation with an uncertain outcome", () => {
    const error = {
      code: "OPERATION_INTERRUPTED",
      message: "runtime replaced",
      context: {
        reason: "runtime_replaced",
        operation: "terminal.open",
        phase: "durable_object_call",
        admitted: "unknown",
        retryable: false,
      },
    };

    expect(classifyEnvironmentProviderFailure(error, "terminal")).toEqual({
      code: "GATEWAY_PROVIDER_OPERATION_UNCERTAIN",
      retryable: false,
    });
    expect(classifyEnvironmentProviderFailure(error, "prepare")).toEqual({
      code: "GATEWAY_PROVIDER_TRANSIENT",
      retryable: true,
      retryAfterMs: 500,
    });
  });

  it("keeps unknown application failures non-retryable", () => {
    expect(classifyEnvironmentProviderFailure(new Error("command failed"), "status")).toEqual({
      code: "GATEWAY_PROVIDER_FAILED",
      retryable: false,
    });
  });
});
