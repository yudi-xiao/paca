import { describe, expect, it, vi } from "vitest";
import {
  configureGitHubAppEnvironment,
  githubAppDeployment,
  githubAppEnvironment,
  githubAppOrigin,
} from "../scripts/github-app-environment";
import { githubAppManifest } from "../scripts/github-app-manifest";

describe("GitHub App deployment isolation", () => {
  it("allows only the agreed origins and routes the internal webhook after migration", () => {
    expect(githubAppOrigin("internal", "https://paca-internal.howlearnwood.com")).toBe(
      "https://paca-internal.howlearnwood.com",
    );
    for (const origin of [
      "https://evil.test",
      "http://paca.howlearnwood.com",
      "https://paca.howlearnwood.com/path",
      "https://paca.howlearnwood.com:444",
    ])
      expect(() => githubAppOrigin("production", origin)).toThrow("GITHUB_APP_ORIGIN_INVALID");
    expect(() => githubAppOrigin("production", "https://paca-internal.howlearnwood.com")).toThrow(
      "GITHUB_APP_ORIGIN_INVALID",
    );
    const manifest = githubAppManifest(
      `http://127.0.0.1:4567/callback/${"a".repeat(64)}`,
      "internal",
      "https://paca-internal.howlearnwood.com",
    );
    expect(manifest.hook_attributes.url).toBe(
      "https://paca-internal.howlearnwood.com/api/integrations/github/webhook",
    );
  });
  it("rejects unknown environments and never maps them to internal", () => {
    expect(githubAppEnvironment()).toBe("internal");
    expect(githubAppEnvironment("production")).toBe("production");
    for (const value of ["", "staging", "../internal", "Production"])
      expect(() => githubAppEnvironment(value)).toThrow("GITHUB_APP_ENVIRONMENT_INVALID");
  });

  it("rejects unknown environments at the secret-writing boundary", async () => {
    const writeSecrets = vi.fn(async () => undefined);
    await expect(
      configureGitHubAppEnvironment(
        "staging" as "internal",
        { id: 2, slug: "fixture", pem: "private-fixture", webhook_secret: "secret-fixture" },
        writeSecrets,
      ),
    ).rejects.toThrow("GITHUB_APP_ENVIRONMENT_INVALID");
    expect(writeSecrets).not.toHaveBeenCalled();
  });

  it("stages production locally without publishing a placeholder Worker or exposing credentials", async () => {
    const writeSecrets = vi.fn(async () => undefined);
    const configuration = {
      id: 1,
      slug: "production",
      pem: "private-fixture",
      webhook_secret: "secret-fixture",
    };
    const report = await configureGitHubAppEnvironment("production", configuration, writeSecrets);
    expect(writeSecrets).not.toHaveBeenCalled();
    expect(report).toMatchObject({ status: "staged", environment: "production" });
    expect(JSON.stringify(report)).not.toContain(configuration.pem);
    expect(JSON.stringify(report)).not.toContain(configuration.webhook_secret);
    expect(githubAppDeployment("production").privateFile).toBe("production.json");
    expect(githubAppDeployment("internal").privateFile).toBe("internal.json");
    const manifest = githubAppManifest(
      `http://127.0.0.1:4567/callback/${"a".repeat(64)}`,
      "production",
    );
    expect(manifest.name).toBe("paca-yudi-delivery-production");
    expect(manifest.public).toBe(false);
    expect(manifest.default_permissions).toEqual({
      metadata: "read",
      checks: "read",
      pull_requests: "read",
    });
  });

  it("retains internal configuration through its explicit secret writer", async () => {
    const writeSecrets = vi.fn(async () => undefined);
    await configureGitHubAppEnvironment(
      "internal",
      { id: 2, slug: "internal", pem: "private-fixture", webhook_secret: "secret-fixture" },
      writeSecrets,
    );
    expect(writeSecrets).toHaveBeenCalledOnce();
    expect(writeSecrets).toHaveBeenCalledWith({
      GITHUB_APP_ID: "2",
      GITHUB_APP_PRIVATE_KEY: "private-fixture",
      GITHUB_WEBHOOK_SECRET: "secret-fixture",
    });
  });
});
