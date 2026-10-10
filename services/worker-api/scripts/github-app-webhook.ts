import * as z from "zod";
import { type GitHubAppEnvironment, githubAppOrigin } from "./github-app-environment";

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    throw Error("GITHUB_APP_WEBHOOK_HTTP_FAILED");
  }
  const reader = response.body?.getReader();
  if (!reader) throw Error("GITHUB_APP_WEBHOOK_RESPONSE_INVALID");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32768) {
        await reader.cancel();
        throw Error("GITHUB_APP_WEBHOOK_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    reader.releaseLock();
  }
}

/** Operator-only fixed endpoint. Never forwards a GitHub-supplied URL or
 * returns the webhook secret (including GitHub's masked secret field). */
export async function configureGitHubAppWebhook(input: {
  environment: GitHubAppEnvironment;
  origin: string;
  token: string;
  apply: boolean;
  fetch?: typeof fetch;
}) {
  const origin = githubAppOrigin(input.environment, input.origin);
  const fetch_ = input.fetch ?? globalThis.fetch;
  const signal = AbortSignal.timeout(20000);
  const desired = {
    url: `${origin}/api/integrations/github/webhook`,
    content_type: "json" as const,
    insecure_ssl: "0" as const,
  };
  if (input.apply) {
    const health = z
      .object({ service: z.literal("paca-worker-api"), environment: z.literal(input.environment) })
      .parse(await boundedJson(await fetch_(`${origin}/health`, { redirect: "manual", signal })));
    if (health.environment !== input.environment) throw Error("GITHUB_APP_WEBHOOK_TARGET_INVALID");
  }
  const request = async (method: "GET" | "PATCH") => {
    const payload = await boundedJson(
      await fetch_("https://api.github.com/app/hook/config", {
        method,
        redirect: "manual",
        signal,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${input.token}`,
          "x-github-api-version": "2026-03-10",
          "user-agent": "Paca-GitHub-Delivery",
          ...(method === "PATCH" ? { "content-type": "application/json" } : {}),
        },
        ...(method === "PATCH" ? { body: JSON.stringify(desired) } : {}),
      }),
    );
    return z
      .object({ url: z.string(), content_type: z.string(), insecure_ssl: z.string() })
      .parse(payload);
  };
  const matches = (value: Awaited<ReturnType<typeof request>>) =>
    value.url === desired.url && value.content_type === "json" && value.insecure_ssl === "0";
  const current = await request("GET");
  const needsUpdate = !matches(current);
  if (input.apply && needsUpdate) {
    if (!matches(await request("PATCH")) || !matches(await request("GET")))
      throw Error("GITHUB_APP_WEBHOOK_UPDATE_NOT_VERIFIED");
  }
  return {
    environment: input.environment,
    webhookUrl: desired.url,
    status: input.apply || !needsUpdate ? "verified" : "update_required",
    updated: input.apply && needsUpdate,
  };
}
