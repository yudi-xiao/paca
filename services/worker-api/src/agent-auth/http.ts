import type { AgentSession } from "@better-auth/agent-auth";
import { createMiddleware } from "hono/factory";

import type { AppBindings, AppVariables } from "../bindings";
import {
  type AgentConstraintContext,
  evaluateAgentCapability,
  type PacaCapabilityName,
} from "./capabilities";

export type ReadAgentSession = (request: Request, env: AppBindings) => Promise<AgentSession | null>;

type AgentHonoEnvironment = {
  Bindings: AppBindings;
  Variables: AppVariables;
};

type ConstraintContextResolver = (context: {
  param(name: string): string;
  query(name: string): string | undefined;
}) => AgentConstraintContext;

function isAgentAuthenticationFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as Record<string, unknown>;
  return (
    candidate.statusCode === 401 ||
    candidate.status === 401 ||
    candidate.status === "UNAUTHORIZED" ||
    (typeof candidate.message === "string" && candidate.message.startsWith("AGENT_JWT_"))
  );
}

export function requireAgentCapability(
  readAgentSession: ReadAgentSession,
  capability: PacaCapabilityName,
  resolveConstraintContext: ConstraintContextResolver,
) {
  return createMiddleware<AgentHonoEnvironment>(async (context, next) => {
    let session: AgentSession | null;
    try {
      session = await readAgentSession(context.req.raw, context.env);
    } catch (error) {
      if (!isAgentAuthenticationFailure(error)) throw error;
      return context.json(
        {
          success: false as const,
          error_code: "AGENT_TOKEN_INVALID",
          error: "Agent authentication failed",
          request_id: context.get("requestId"),
        },
        401,
      );
    }

    if (!session) {
      return context.json(
        {
          success: false as const,
          error_code: "AGENT_UNAUTHENTICATED",
          error: "Agent authentication required",
          request_id: context.get("requestId"),
        },
        401,
      );
    }

    const decision = evaluateAgentCapability(
      session,
      capability,
      resolveConstraintContext(context.req),
    );
    if (!decision.allowed) {
      return context.json(
        {
          success: false as const,
          error_code: decision.code,
          error: "Agent capability denied",
          request_id: context.get("requestId"),
        },
        403,
      );
    }

    context.set("agentSession", session);
    await next();
  });
}
