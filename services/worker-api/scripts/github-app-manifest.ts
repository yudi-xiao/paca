import * as z from "zod";
import { githubAppJwt } from "../src/github-delivery/github-app";
import {
  type GitHubAppEnvironment,
  githubAppDeployment,
  githubAppOrigin,
} from "./github-app-environment";

export const githubAppPermissions = {
  metadata: "read",
  checks: "read",
  pull_requests: "read",
} as const;
export function githubAppManifest(
  callback: string,
  environment: GitHubAppEnvironment = "prod",
  configuredOrigin?: string,
) {
  const url = new URL(callback);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    !/^\/callback\/[a-f0-9]{64}$/.test(url.pathname) ||
    url.search ||
    url.hash
  )
    throw Error("GITHUB_APP_CALLBACK_INVALID");
  const deployment = githubAppDeployment(environment);
  const origin = githubAppOrigin(environment, configuredOrigin ?? deployment.origin);
  return {
    name: deployment.name,
    description:
      "Paca delivery verification for yudi-xiao/paca. Read-only checks and pull requests.",
    url: origin,
    public: false,
    redirect_url: callback,
    hook_attributes: {
      url: `${origin}/api/integrations/github/webhook`,
      active: true,
    },
    default_permissions: githubAppPermissions,
    default_events: ["check_run", "check_suite", "pull_request", "pull_request_review"],
    request_oauth_on_install: false,
  };
}
const appSchema = z.object({
  id: z.number().int().positive().safe(),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
  owner: z.object({ login: z.literal("yudi-xiao") }),
  permissions: z
    .object({
      metadata: z.literal("read"),
      checks: z.literal("read"),
      pull_requests: z.literal("read"),
    })
    .strict(),
  pem: z.string().min(100).max(32000),
  webhook_secret: z.string().min(20).max(1024),
});
export function githubAppConfiguration(raw: unknown) {
  const parsed = appSchema.safeParse(raw);
  if (!parsed.success) throw Error("GITHUB_APP_CONFIGURATION_INVALID");
  githubAppJwt({ appId: String(parsed.data.id), privateKey: parsed.data.pem });
  // Discard OAuth client secrets: this integration does not use user OAuth.
  return {
    id: parsed.data.id,
    slug: parsed.data.slug,
    owner: parsed.data.owner,
    permissions: parsed.data.permissions,
    pem: parsed.data.pem,
    webhook_secret: parsed.data.webhook_secret,
  };
}
export function manifestCallbackCode(url: URL, nonce: string): string {
  const codes = url.searchParams.getAll("code");
  const states = url.searchParams.getAll("state");
  if (
    url.pathname !== `/callback/${nonce}` ||
    codes.length !== 1 ||
    states.length !== 1 ||
    states[0] !== nonce ||
    !/^[a-zA-Z0-9_-]{20,200}$/.test(codes[0] ?? "") ||
    [...url.searchParams.keys()].some((key) => key !== "code" && key !== "state")
  )
    throw Error("GITHUB_APP_CALLBACK_INVALID");
  return codes[0] as string;
}
