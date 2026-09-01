import { type AgentAuthEvent, type AgentAuthOptions, agentAuth } from "@better-auth/agent-auth";

import { constantTimeEqual } from "../security";
import { areKnownPacaCapabilities, pacaCapabilities } from "./capabilities";

const AGENT_MAX_LIFETIME_SECONDS = 24 * 60 * 60;
const AGENT_SESSION_TTL_SECONDS = 60 * 60;

export type PacaAgentAuthPluginOptions = {
  autonomousHostEnrollmentSecret?: string;
  onEvent?: (event: AgentAuthEvent) => void | Promise<void>;
  onExecute?: AgentAuthOptions["onExecute"];
};

/**
 * All direct Agent Auth package usage lives in this adapter so the rest of
 * Paca is insulated from the still-evolving protocol/plugin API.
 */
export function pacaAgentAuth(options: PacaAgentAuthPluginOptions = {}) {
  const autonomousHostEnrollmentSecret = options.autonomousHostEnrollmentSecret?.trim();
  if (autonomousHostEnrollmentSecret && autonomousHostEnrollmentSecret.length < 32) {
    throw new Error("AUTONOMOUS_HOST_ENROLLMENT_SECRET_TOO_SHORT");
  }
  const autonomousEnabled = Boolean(
    autonomousHostEnrollmentSecret && autonomousHostEnrollmentSecret.length >= 32,
  );

  return agentAuth({
    providerName: "Paca",
    providerDescription: "Paca project, task, document, environment, and workflow capabilities.",
    modes: autonomousEnabled ? ["delegated", "autonomous"] : ["delegated"],
    capabilities: pacaCapabilities,
    validateCapabilities: areKnownPacaCapabilities,
    requireAuthForCapabilities: false,
    approvalMethods: ["device_authorization"],
    deviceAuthorizationPage: "/device/capabilities",
    allowDynamicHostRegistration: autonomousEnabled
      ? async (context) => {
          const provided = context.headers?.get("x-paca-autonomous-host-enrollment");
          return Boolean(
            provided &&
              autonomousHostEnrollmentSecret &&
              (await constantTimeEqual(autonomousHostEnrollmentSecret, provided)),
          );
        }
      : false,
    resolveAutonomousUser: autonomousEnabled
      ? ({ agentId, hostName }) => ({
          id: `agent:${agentId}`,
          name: hostName ? `${hostName} autonomous agent` : `Autonomous agent ${agentId}`,
          email: `${agentId}@agents.invalid`,
        })
      : undefined,
    defaultHostCapabilities: [],
    allowedKeyAlgorithms: ["Ed25519"],
    jwtFormat: "simple",
    jwtMaxAge: 60,
    agentSessionTTL: AGENT_SESSION_TTL_SECONDS,
    agentMaxLifetime: AGENT_MAX_LIFETIME_SECONDS,
    absoluteLifetime: AGENT_MAX_LIFETIME_SECONDS,
    maxAgentsPerUser: 25,
    freshSessionWindow: 5 * 60,
    blockedCapabilities: ["environment.connect", "workflow.execute"],
    jtiCacheStorage: "secondary-storage",
    jwksCacheStorage: "secondary-storage",
    dangerouslySkipJtiCheck: false,
    trustProxy: false,
    onEvent: options.onEvent,
    onExecute: options.onExecute,
  });
}
