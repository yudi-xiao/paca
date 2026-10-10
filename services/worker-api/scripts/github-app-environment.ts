export type GitHubAppEnvironment = "prod";
export function githubAppEnvironment(value?: string): GitHubAppEnvironment {
  if (value === undefined || value === "prod") return "prod";
  throw new Error("GITHUB_APP_ENVIRONMENT_INVALID");
}
export function githubAppDeployment(environment: GitHubAppEnvironment) {
  githubAppEnvironment(environment);
  return {
    environment,
    privateFile: "prod.json",
    name: "paca-yudi-delivery",
    origin: "https://paca.howlearnwood.com",
    guard: "deploy:guard",
    stageOnly: false,
  } as const;
}
export async function configureGitHubAppEnvironment(
  environment: GitHubAppEnvironment,
  configuration: { id: number; slug: string; pem: string; webhook_secret: string },
  writeSecrets: (secrets: {
    GITHUB_APP_ID: string;
    GITHUB_APP_PRIVATE_KEY: string;
    GITHUB_WEBHOOK_SECRET: string;
  }) => Promise<void>,
) {
  githubAppDeployment(environment);
  await writeSecrets({
    GITHUB_APP_ID: String(configuration.id),
    GITHUB_APP_PRIVATE_KEY: configuration.pem,
    GITHUB_WEBHOOK_SECRET: configuration.webhook_secret,
  });
  return {
    status: "configured",
    appId: configuration.id,
    slug: configuration.slug,
    installUrl: `https://github.com/apps/${configuration.slug}/installations/new`,
    repository: "yudi-xiao/paca",
    environment,
  };
}
export function githubAppOrigin(environment: GitHubAppEnvironment, origin: string): string {
  githubAppEnvironment(environment);
  if (origin === "https://paca.howlearnwood.com") return origin;
  throw new Error("GITHUB_APP_ORIGIN_INVALID");
}
