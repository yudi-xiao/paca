import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { type DelegatedAgentConfig, getDelegatedAgentStatus } from "../src/agent-auth/agent-client";
import { AgentHostEnrollmentError } from "../src/agent-auth/host-enrollment";

const configPath =
  process.env.PACA_AGENT_CONFIG?.trim() ||
  fileURLToPath(new URL("../../../.paca/agents/demo-task-agent.json", import.meta.url));

async function main() {
  const config = JSON.parse(await readFile(configPath, "utf8")) as DelegatedAgentConfig;
  console.log(JSON.stringify(await getDelegatedAgentStatus({ config })));
}

main().catch((error: unknown) => {
  const code =
    error instanceof AgentHostEnrollmentError
      ? error.code
      : error instanceof Error
        ? error.name
        : "UNKNOWN_ERROR";
  console.error(JSON.stringify({ status: "error", step: "agent-status", code }));
  process.exitCode = 1;
});
