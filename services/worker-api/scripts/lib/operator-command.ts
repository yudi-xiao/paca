import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Capture credential-bearing CLI output in process memory, never log stdout,
 * stderr, errors (which can contain args) or database URLs. */
export async function operatorJson(executable: string, args: string[]): Promise<unknown> {
  try {
    const result = await execute(executable, args, {
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error("OPERATOR_COMMAND_FAILED");
  }
}
