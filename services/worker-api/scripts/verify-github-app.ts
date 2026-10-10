import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod";
import { GitHubAppDeliverySource, githubAppJwt } from "../src/github-delivery/github-app";
import { githubJson } from "../src/github-delivery/github-http";
import { readGitHubAppConfiguration } from "./github-app-private-config";

async function main() {
  const path = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../.paca/github-app/internal.json",
  );
  const configuration = await readGitHubAppConfiguration(path);
  const credentials = { appId: String(configuration.id), privateKey: configuration.pem };
  const jwt = githubAppJwt(credentials);
  const signal = AbortSignal.timeout(20000);
  const installation = z
    .object({
      id: z.number().int().positive().safe(),
      app_id: z.literal(configuration.id),
      account: z.object({ login: z.literal("yudi-xiao") }),
      repository_selection: z.literal("selected"),
      suspended_at: z.null(),
      permissions: z
        .object({
          metadata: z.literal("read"),
          checks: z.literal("read"),
          pull_requests: z.literal("read"),
        })
        .strict(),
    })
    .parse(await githubJson("/repos/yudi-xiao/paca/installation", jwt, signal));
  // Discovery requests a single repository by name, then all subsequent
  // application reads use its verified immutable ID.
  const token = z
    .object({
      token: z.string().min(1).max(16384),
      repositories: z
        .array(
          z.object({
            id: z.number().int().positive().safe(),
            full_name: z.literal("yudi-xiao/paca"),
          }),
        )
        .length(1),
    })
    .parse(
      await githubJson(`/app/installations/${installation.id}/access_tokens`, jwt, signal, fetch, {
        repositories: ["paca"],
        permissions: configuration.permissions,
      }),
    );
  const repositoryId = token.repositories[0]?.id;
  if (!repositoryId) throw Error("GITHUB_APP_INSTALLATION_INVALID");
  await new GitHubAppDeliverySource(credentials).verifyRepository({
    requestId: crypto.randomUUID(),
    expectedVersion: 0,
    repositoryId,
    installationId: installation.id,
    policy: {
      owner: "yudi-xiao",
      repository: "paca",
      requiredChecks: [{ name: "Setup verification only", appId: 1 }],
      maxCheckAgeSeconds: 86400,
      reviewerIds: [],
      requiredApprovals: 0,
    },
  });
  const body = JSON.stringify({ zen: "Paca signed webhook readiness check" });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(configuration.webhook_secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = Array.from(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const response = await fetch("https://paca.howlearnwood.com/api/integrations/github/webhook", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    body,
    headers: {
      "content-type": "application/json",
      "x-github-delivery": crypto.randomUUID(),
      "x-github-event": "ping",
      "x-hub-signature-256": `sha256=${signature}`,
    },
  });
  if (response.status !== 200) throw Error("GITHUB_APP_WEBHOOK_NOT_READY");
  await response.body?.cancel();
  console.log(
    JSON.stringify({
      status: "ok",
      environment: "internal",
      appId: configuration.id,
      repository: "yudi-xiao/paca",
      repositoryId,
      installationId: installation.id,
      repositorySelection: "selected",
      permissions: configuration.permissions,
      signedWebhook: "verified",
    }),
  );
}
main().catch(() => {
  console.error(JSON.stringify({ status: "unavailable", code: "GITHUB_APP_VERIFICATION_FAILED" }));
  process.exitCode = 1;
});
