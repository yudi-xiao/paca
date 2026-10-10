import { open } from "node:fs/promises";
import {
  GitHubDeliveryError,
  githubDeliveryPolicySchema,
  githubDeliveryReferenceSchema,
} from "../src/github-delivery/evidence";
import { GitHubDeliveryReader } from "../src/github-delivery/github";

async function main() {
  // A local diagnostic, not a public endpoint or a persistent acceptance record.
  // Policy comes from the trusted operator, never an Agent's submitted result.
  const policyPath = process.env.PACA_GITHUB_POLICY_FILE?.trim();
  if (!policyPath) throw new GitHubDeliveryError("GITHUB_DELIVERY_INPUT_INVALID");
  const file = await open(policyPath, "r");
  let raw: unknown;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16000)
      throw new GitHubDeliveryError("GITHUB_DELIVERY_INPUT_INVALID");
    raw = JSON.parse(await file.readFile("utf8")) as unknown;
  } finally {
    await file.close();
  }
  const policy = githubDeliveryPolicySchema.safeParse(raw);
  const reference = githubDeliveryReferenceSchema.safeParse({
    pullNumber: Number(process.env.PACA_GITHUB_PULL_NUMBER),
    headSha: process.env.PACA_GITHUB_HEAD_SHA?.trim(),
  });
  if (!policy.success || !reference.success)
    throw new GitHubDeliveryError("GITHUB_DELIVERY_INPUT_INVALID");
  const report = await new GitHubDeliveryReader(
    process.env.PACA_GITHUB_INSTALLATION_TOKEN?.trim() || undefined,
  ).inspect(policy.data, reference.data);
  console.log(JSON.stringify({ inspectionOnly: true, humanAcceptance: "required", ...report }));
  process.exitCode = report.state === "awaiting_acceptance" ? 0 : 1;
}
try {
  await main();
} catch (error) {
  console.error(
    JSON.stringify({
      inspectionOnly: true,
      state: "unavailable",
      code: error instanceof GitHubDeliveryError ? error.code : "GITHUB_DELIVERY_INPUT_INVALID",
    }),
  );
  process.exitCode = 2;
}
