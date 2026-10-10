export type GitHubAppEnvironment = "internal" | "production";

export function githubAppEnvironment(value?: string): GitHubAppEnvironment {
  if (value === undefined || value === "internal") return "internal";
  if (value === "production") return "production";
  throw new Error("GITHUB_APP_ENVIRONMENT_INVALID");
}

export function githubAppDeployment(environment: GitHubAppEnvironment) {
  githubAppEnvironment(environment);
  // Production is staged locally until candidate deployment has passed its
  // owner/database gates. Secret bulk can otherwise create a placeholder
  // Worker early, bypassing the unpublished production boundary.
  return {
    environment,
    privateFile: `${environment}.json`,
    name: environment === "production" ? "paca-yudi-delivery-production" : "paca-yudi-delivery",
    origin: "https://paca.howlearnwood.com",
    guard: environment === "production" ? "deploy:guard:production" : "deploy:guard",
    stageOnly: environment === "production",
  } as const;
}

export async function configureGitHubAppEnvironment(
  environment: GitHubAppEnvironment,
  configuration: { id: number; slug: string; pem: string; webhook_secret: string },
  writeInternalSecrets: (secrets: {
    GITHUB_APP_ID: string;
    GITHUB_APP_PRIVATE_KEY: string;
    GITHUB_WEBHOOK_SECRET: string;
  }) => Promise<void>,
) {
  if (!githubAppDeployment(environment).stageOnly) {
    await writeInternalSecrets({
      GITHUB_APP_ID: String(configuration.id),
      GITHUB_APP_PRIVATE_KEY: configuration.pem,
      GITHUB_WEBHOOK_SECRET: configuration.webhook_secret,
    });
  }
  return {
    status: environment === "production" ? "staged" : "configured",
    appId: configuration.id,
    slug: configuration.slug,
    installUrl: `https://github.com/apps/${configuration.slug}/installations/new`,
    repository: "yudi-xiao/paca",
    environment,
  };
}

export function githubAppOrigin(environment: GitHubAppEnvironment, origin: string): string {
  githubAppEnvironment(environment);
  if (
    origin === "https://paca.howlearnwood.com" ||
    (environment === "internal" && origin === "https://paca-internal.howlearnwood.com")
  )
    return origin;
  throw new Error("GITHUB_APP_ORIGIN_INVALID");
}
