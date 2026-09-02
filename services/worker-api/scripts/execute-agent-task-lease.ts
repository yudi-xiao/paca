import { readFile } from "node:fs/promises";

import type { DelegatedAgentConfig } from "../src/agent-auth/agent-client";
import {
  AgentTaskHarnessClient,
  delegatedAgentTaskHarnessTransport,
} from "../src/agent-task/harness-client";
import { agentTaskLeaseCommandSchema } from "../src/agent-task/protocol";

async function readStandardInput(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const configPath = process.env.PACA_AGENT_CONFIG?.trim();
  if (!configPath) throw new Error("PACA_AGENT_CONFIG_REQUIRED");
  const config = JSON.parse(await readFile(configPath, "utf8")) as DelegatedAgentConfig;
  if (!config.capabilities.includes("task.execute")) {
    throw new Error("AGENT_TASK_EXECUTE_CAPABILITY_NOT_REQUESTED");
  }
  const value = await readStandardInput().then((input) => {
    try {
      return JSON.parse(input.trim()) as unknown;
    } catch {
      throw new Error("AGENT_TASK_COMMAND_INVALID");
    }
  });
  const parsed = agentTaskLeaseCommandSchema.safeParse(value);
  if (!parsed.success) throw new Error("AGENT_TASK_COMMAND_INVALID");
  const command = parsed.data;
  const client = new AgentTaskHarnessClient(
    delegatedAgentTaskHarnessTransport(config),
    command.action === "claim" ? command.harness : { kind: "custom" },
  );
  const result = await client.execute(command);
  console.log(JSON.stringify(result));
}

main().catch((error: unknown) => {
  const code = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  console.error(JSON.stringify({ status: "error", step: "agent-task-lease", code }));
  process.exitCode = 1;
});
