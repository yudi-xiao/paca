import { describe, expect, it, vi } from "vitest";
import {
  configureGitHubAppEnvironment,
  githubAppDeployment,
  githubAppEnvironment,
  githubAppOrigin,
} from "../scripts/github-app-environment";
import { githubAppManifest } from "../scripts/github-app-manifest";

describe("single production GitHub App", () => {
  it("reuses the existing App and accepts only the primary origin", () => {
    expect(githubAppEnvironment()).toBe("prod");
    expect(githubAppDeployment("prod")).toMatchObject({
      name: "paca-yudi-delivery",
      privateFile: "prod.json",
      stageOnly: false,
    });
    expect(githubAppOrigin("prod", "https://paca.howlearnwood.com")).toBe(
      "https://paca.howlearnwood.com",
    );
    for (const value of ["internal", "production", "staging", ""])
      expect(() => githubAppEnvironment(value)).toThrow("GITHUB_APP_ENVIRONMENT_INVALID");
    for (const origin of [
      "https://paca-internal.howlearnwood.com",
      "https://evil.test",
      "https://paca.howlearnwood.com/path",
    ])
      expect(() => githubAppOrigin("prod", origin)).toThrow("GITHUB_APP_ORIGIN_INVALID");
    expect(githubAppManifest(`http://127.0.0.1:4567/callback/${"a".repeat(64)}`).name).toBe(
      "paca-yudi-delivery",
    );
  });
  it("writes the reusable credentials without exposing them in reports", async () => {
    const write = vi.fn(async () => undefined);
    const report = await configureGitHubAppEnvironment(
      "prod",
      {
        id: 5260553,
        slug: "paca-yudi-delivery",
        pem: "private-fixture",
        webhook_secret: "secret-fixture",
      },
      write,
    );
    expect(write).toHaveBeenCalledWith({
      GITHUB_APP_ID: "5260553",
      GITHUB_APP_PRIVATE_KEY: "private-fixture",
      GITHUB_WEBHOOK_SECRET: "secret-fixture",
    });
    expect(report).toMatchObject({ status: "configured", environment: "prod" });
    expect(JSON.stringify(report)).not.toMatch(/private-fixture|secret-fixture/);
  });
  it("rejects an unknown deployment before writing secrets", async () => {
    const write = vi.fn(async () => undefined);
    await expect(
      configureGitHubAppEnvironment(
        "internal" as "prod",
        { id: 1, slug: "test", pem: "private", webhook_secret: "secret" },
        write,
      ),
    ).rejects.toThrow("GITHUB_APP_ENVIRONMENT_INVALID");
    expect(write).not.toHaveBeenCalled();
  });
});
