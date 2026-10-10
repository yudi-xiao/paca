import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod";
import { githubAppJwt } from "../src/github-delivery/github-app";
import { githubJson } from "../src/github-delivery/github-http";
import { readGitHubAppConfiguration } from "./github-app-private-config";

let stage = "configuration";

async function main() {
  const configuration = await readGitHubAppConfiguration(
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../.paca/github-app/internal.json"),
  );
  const token = githubAppJwt({ appId: String(configuration.id), privateKey: configuration.pem });
  const signal = AbortSignal.timeout(20000);
  stage = "webhook_configuration";
  z.object({
    url: z.literal("https://paca.howlearnwood.com/api/integrations/github/webhook"),
    content_type: z.literal("json"),
    insecure_ssl: z.literal("0"),
  }).parse(await githubJson("/app/hook/config", token, signal));
  const deliverySchema = z.object({
    id: z.union([
      z.number().int().positive().safe().transform(String),
      z.string().regex(/^[1-9][0-9]{0,19}$/),
    ]),
    event: z.string().max(80),
    action: z.string().nullable().optional(),
    status_code: z.number().int(),
    installation_id: z.number().int().nullable().optional(),
    delivered_at: z.string(),
    redelivery: z.boolean(),
  });
  stage = "deliveries";
  const deliveries = z
    .array(deliverySchema)
    .max(30)
    .parse(await githubJson("/app/hook/deliveries?per_page=30", token, signal));
  const installation = deliveries.find(
    (delivery) => delivery.event === "installation" && delivery.action === "created",
  );
  if (process.argv.includes("--redeliver-failed-ping")) {
    const failed = deliveries.find(
      (delivery) => delivery.event === "ping" && delivery.status_code >= 400,
    );
    if (failed) {
      const response = await fetch(
        `https://api.github.com/app/hook/deliveries/${failed.id}/attempts`,
        {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "x-github-api-version": "2026-03-10",
            "user-agent": "Paca-GitHub-Delivery",
          },
        },
      );
      const accepted = response.status === 202;
      await response.body?.cancel();
      if (!accepted) throw Error("GITHUB_APP_REDELIVERY_FAILED");
      console.log(JSON.stringify({ status: "accepted", action: "redeliver_failed_ping" }));
    }
  }
  let installedRepositories: string[] | null = null;
  if (installation) {
    stage = "installation_payload";
    const detail = z
      .object({
        request: z.object({
          payload: z.object({
            repositories: z.array(z.object({ full_name: z.string().max(200) })).max(100),
            installation: z.object({
              repository_selection: z.literal("selected"),
              account: z.object({ login: z.literal("yudi-xiao") }),
            }),
          }),
        }),
      })
      .parse(await githubJson(`/app/hook/deliveries/${installation.id}`, token, signal));
    installedRepositories = detail.request.payload.repositories.map(
      (repository) => repository.full_name,
    );
    if (installedRepositories.length !== 1 || installedRepositories[0] !== "yudi-xiao/paca")
      throw Error("GITHUB_APP_INSTALLATION_SCOPE_INVALID");
  }
  console.log(
    JSON.stringify({
      status: "ok",
      webhookConfiguration: "verified",
      installedRepositories,
      deliveries: deliveries.map((delivery) => ({
        event: delivery.event,
        action: delivery.action,
        status: delivery.status_code,
        installationId: delivery.installation_id,
        at: delivery.delivered_at,
        redelivery: delivery.redelivery,
      })),
    }),
  );
}
main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      status: "unavailable",
      code: "GITHUB_APP_WEBHOOK_INSPECTION_FAILED",
      stage,
      fields:
        error instanceof z.ZodError ? error.issues.map((issue) => issue.path.join(".")) : undefined,
    }),
  );
  process.exitCode = 1;
});
