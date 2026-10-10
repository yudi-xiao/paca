import { readFile } from "node:fs/promises";
import { assertProductionConfiguration } from "./lib/production-config";

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error("RELEASE_ARGUMENT_INVALID");
  const [worker, gateway] = await Promise.all([
    readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    readFile(new URL("../../environment-gateway/wrangler.jsonc", import.meta.url), "utf8"),
  ]);
  assertProductionConfiguration(JSON.parse(worker), JSON.parse(gateway));
  console.log(
    JSON.stringify({ status: "ok", step: "production-deploy-config", environment: "prod" }),
  );
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
