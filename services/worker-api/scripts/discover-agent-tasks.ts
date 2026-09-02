import { readFile } from "node:fs/promises";

import type { DelegatedAgentConfig } from "../src/agent-auth/agent-client";
import {
  AgentTaskHarnessClient,
  delegatedAgentTaskHarnessTransport,
} from "../src/agent-task/harness-client";

async function main(): Promise<void> {
  const configPath = process.env.PACA_AGENT_CONFIG?.trim();
  if (!configPath) throw new Error("PACA_AGENT_CONFIG_REQUIRED");
  const config = JSON.parse(await readFile(configPath, "utf8")) as DelegatedAgentConfig;
  if (!config.capabilities.includes("task.execute")) {
    throw new Error("AGENT_TASK_EXECUTE_CAPABILITY_NOT_REQUESTED");
  }
  const client = new AgentTaskHarnessClient(delegatedAgentTaskHarnessTransport(config), {
    kind: "custom",
  });
  console.log(JSON.stringify(await client.discover()));
}

main().catch((error: unknown) => {
  const code = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  console.error(JSON.stringify({ status: "error", step: "agent-task-discovery", code }));
  process.exitCode = 1;
});
