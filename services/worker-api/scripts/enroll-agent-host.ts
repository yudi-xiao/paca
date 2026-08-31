import { fileURLToPath } from "node:url";

import {
  AgentHostEnrollmentError,
  assertAgentHostConfigAbsent,
  enrollAgentHost,
  writeAgentHostConfig,
} from "../src/agent-auth/host-enrollment";

const DEFAULT_PROVIDER_ORIGIN = "https://paca.howlearnwood.com";
const DEFAULT_CONFIG_PATH = fileURLToPath(
  new URL("../../../.paca/agent-host.json", import.meta.url),
);

async function readHiddenLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    let value = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) value += chunk;
    return value.trim();
  }
  process.stdout.write(prompt);
  const input = process.stdin;
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  let value = "";
  try {
    await new Promise<void>((resolve, reject) => {
      const onData = (chunk: string) => {
        for (const character of chunk) {
          if (character === "\u0003") {
            input.off("data", onData);
            reject(new AgentHostEnrollmentError("AGENT_HOST_ENROLLMENT_CANCELLED"));
            return;
          }
          if (character === "\r" || character === "\n") {
            input.off("data", onData);
            resolve();
            return;
          }
          if (character === "\u007f") value = value.slice(0, -1);
          else value += character;
        }
      };
      input.on("data", onData);
    });
  } finally {
    input.setRawMode(false);
    input.pause();
    process.stdout.write("\n");
  }
  return value;
}

async function main(): Promise<void> {
  const providerOrigin = process.env.PACA_AGENT_HOST_ORIGIN?.trim() || DEFAULT_PROVIDER_ORIGIN;
  const configPath = process.env.PACA_AGENT_HOST_CONFIG?.trim() || DEFAULT_CONFIG_PATH;
  await assertAgentHostConfigAbsent(configPath);
  const enrollmentToken = await readHiddenLine("Agent Host enrollment token: ");
  const config = await enrollAgentHost({ providerOrigin, enrollmentToken });
  await writeAgentHostConfig(configPath, config);
  console.log(
    JSON.stringify({
      status: "ok",
      step: "agent-host-enrolled",
      hostId: config.hostId,
      hostName: config.hostName,
      providerOrigin: config.providerOrigin,
      configPath,
      keyAlgorithm: config.keyAlgorithm,
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
  console.error(JSON.stringify({ status: "error", step: "agent-host-enroll", code }));
  process.exitCode = 1;
});
