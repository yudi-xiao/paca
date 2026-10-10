import { readFile } from "node:fs/promises";
import { assertProductionConfiguration, type ReleaseStage } from "./lib/production-config";

async function main(): Promise<void> {
  const stage = process.argv[2];
  if (stage !== "candidate" && stage !== "release") throw new Error("RELEASE_STAGE_REQUIRED");
  const [worker, gateway] = await Promise.all([
    readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    readFile(new URL("../../environment-gateway/wrangler.jsonc", import.meta.url), "utf8"),
  ]);
  assertProductionConfiguration(JSON.parse(worker), JSON.parse(gateway), stage as ReleaseStage);
  console.log(JSON.stringify({ status: "ok", step: "production-deploy-config", stage }));
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      status: "error",
      step: "production-deploy-config",
      code: error instanceof Error ? error.message : "RELEASE_CONFIGURATION_INVALID",
    }),
  );
  process.exitCode = 1;
});
