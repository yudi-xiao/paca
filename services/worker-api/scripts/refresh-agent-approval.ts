import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  type DelegatedAgentConfig,
  readAgentHostConfig,
  requestAgentDeviceAuthorization,
} from "../src/agent-auth/agent-client";
import { AgentHostEnrollmentError } from "../src/agent-auth/host-enrollment";

const root = new URL("../../../", import.meta.url);
const hostConfigPath =
  process.env.PACA_AGENT_HOST_CONFIG?.trim() ||
  fileURLToPath(new URL(".paca/agent-host.json", root));
const agentConfigPath =
  process.env.PACA_AGENT_CONFIG?.trim() ||
  fileURLToPath(new URL(".paca/agents/demo-task-agent.json", root));

async function main() {
  const agent = JSON.parse(await readFile(agentConfigPath, "utf8")) as DelegatedAgentConfig;
  const approval = await requestAgentDeviceAuthorization({
    hostConfig: await readAgentHostConfig(hostConfigPath),
    agentId: agent.agentId,
  });
  console.log(
    JSON.stringify({
      status: "pending_user_approval",
      agentId: agent.agentId,
      agentName: agent.agentName,
      approvalUrl: approval.verificationUriComplete,
      userCode: approval.userCode,
      expiresIn: approval.expiresIn,
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
  console.error(JSON.stringify({ status: "error", step: "agent-approval-refresh", code }));
  process.exitCode = 1;
});
