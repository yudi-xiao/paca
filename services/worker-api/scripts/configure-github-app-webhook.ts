import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { githubAppJwt } from "../src/github-delivery/github-app";
import { githubAppDeployment, githubAppEnvironment } from "./github-app-environment";
import { readGitHubAppConfiguration } from "./github-app-private-config";
import { configureGitHubAppWebhook } from "./github-app-webhook";

async function main() {
  if (process.argv.slice(2).some((argument) => argument !== "--apply"))
    throw Error("GITHUB_APP_WEBHOOK_ARGUMENT_INVALID");
  const environment = githubAppEnvironment(process.env.PACA_GITHUB_APP_ENVIRONMENT);
  const path = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../.paca/github-app",
    githubAppDeployment(environment).privateFile,
  );
  const configuration = await readGitHubAppConfiguration(path);
  if (environment === "production") {
    const internal = await readGitHubAppConfiguration(resolve(dirname(path), "internal.json"));
    if (configuration.id === internal.id) throw Error("GITHUB_APP_ENVIRONMENT_REUSE_FORBIDDEN");
  }
  const worker = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  console.log(
    JSON.stringify(
      await configureGitHubAppWebhook({
        environment,
        origin: worker.env?.[environment]?.vars?.BETTER_AUTH_URL,
        token: githubAppJwt({ appId: String(configuration.id), privateKey: configuration.pem }),
        apply: process.argv.includes("--apply"),
      }),
    ),
  );
}
main().catch(() => {
  console.error(
    JSON.stringify({ status: "failed", code: "GITHUB_APP_WEBHOOK_CONFIGURATION_FAILED" }),
  );
  process.exitCode = 1;
});
