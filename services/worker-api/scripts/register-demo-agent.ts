import { fileURLToPath } from "node:url";

import {
  readAgentHostConfig,
  registerDelegatedAgent,
  writeDelegatedAgentConfig,
} from "../src/agent-auth/agent-client";
import {
  AgentHostEnrollmentError,
  assertAgentHostConfigAbsent,
} from "../src/agent-auth/host-enrollment";

const root = new URL("../../../", import.meta.url);
const hostConfigPath =
  process.env.PACA_AGENT_HOST_CONFIG?.trim() ||
  fileURLToPath(new URL(".paca/agent-host.json", root));
const agentConfigPath =
  process.env.PACA_AGENT_CONFIG?.trim() ||
  fileURLToPath(new URL(".paca/agents/demo-task-agent.json", root));

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new AgentHostEnrollmentError(`${name}_REQUIRED`);
  return value;
}

async function main() {
  await assertAgentHostConfigAbsent(agentConfigPath);
  const registration = await registerDelegatedAgent({
    hostConfig: await readAgentHostConfig(hostConfigPath),
    agentName: process.env.PACA_AGENT_NAME?.trim() || "Demo Backlog Agent",
    organizationId: required("PACA_ORGANIZATION_ID"),
    projectId: required("PACA_PROJECT_ID"),
    taskId: required("PACA_TASK_ID"),
  });
  await writeDelegatedAgentConfig(agentConfigPath, registration.config);
  console.log(
    JSON.stringify({
      status: "pending_user_approval",
      agentId: registration.config.agentId,
      agentName: registration.config.agentName,
      approvalUrl: registration.approval.verificationUriComplete,
      userCode: registration.approval.userCode,
      expiresIn: registration.approval.expiresIn,
      requestedCapabilities: registration.config.capabilities,
      grantRequests: registration.config.grantRequests,
      configPath: agentConfigPath,
    }),
  );
}

main().catch((error: unknown) => {
  const code =
    error instanceof AgentHostEnrollmentError
      ? error.code
      : error instanceof Error
        ? error.name
        : "UNKNOWN_ERROR";
  console.error(JSON.stringify({ status: "error", step: "delegated-agent-register", code }));
  process.exitCode = 1;
});
