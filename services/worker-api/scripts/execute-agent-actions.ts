import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { type DelegatedAgentConfig, executeAgentCapability } from "../src/agent-auth/agent-client";
import { AgentHostEnrollmentError } from "../src/agent-auth/host-enrollment";

type AgentAction = { capability: string; arguments: Record<string, unknown> };
const root = new URL("../../../", import.meta.url);
const agentConfigPath =
  process.env.PACA_AGENT_CONFIG?.trim() ||
  fileURLToPath(new URL(".paca/agents/demo-task-agent.json", root));

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new AgentHostEnrollmentError(`${name}_REQUIRED`);
  return value;
}

async function main() {
  const config = JSON.parse(await readFile(agentConfigPath, "utf8")) as DelegatedAgentConfig;
  const actions = JSON.parse(
    await readFile(required("PACA_AGENT_ACTIONS_FILE"), "utf8"),
  ) as unknown;
  if (!Array.isArray(actions)) throw new AgentHostEnrollmentError("AGENT_ACTIONS_INVALID");
  const results: unknown[] = [];
  for (const action of actions as AgentAction[]) {
    if (
      typeof action?.capability !== "string" ||
      !action.arguments ||
      typeof action.arguments !== "object" ||
      Array.isArray(action.arguments)
    ) {
      throw new AgentHostEnrollmentError("AGENT_ACTIONS_INVALID");
    }
    results.push(
      await executeAgentCapability({
        config,
        capability: action.capability,
        arguments: action.arguments,
      }),
    );
  }
  console.log(JSON.stringify({ status: "ok", actionCount: results.length, results }));
}

main().catch((error: unknown) => {
  const code =
    error instanceof AgentHostEnrollmentError
      ? error.code
      : error instanceof Error
        ? error.name
        : "UNKNOWN_ERROR";
  console.error(JSON.stringify({ status: "error", step: "agent-actions-execute", code }));
  process.exitCode = 1;
});
