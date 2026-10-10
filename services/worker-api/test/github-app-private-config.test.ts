import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { githubAppConfiguration } from "../scripts/github-app-manifest";
import {
  readGitHubAppConfiguration,
  saveGitHubAppConfiguration,
} from "../scripts/github-app-private-config";

it("stores only private credentials, refuses overwrite and rejects insecure or symlinked recovery files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paca-github-config-test-"));
  const path = join(directory, "private", "internal.json");
  try {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const configuration = githubAppConfiguration({
      id: 1,
      slug: "test",
      owner: { login: "yudi-xiao" },
      permissions: { metadata: "read", checks: "read", pull_requests: "read" },
      pem: privateKey.export({ format: "pem", type: "pkcs1" }).toString(),
      webhook_secret: "s".repeat(40),
      client_secret: "discard",
    });
    await saveGitHubAppConfiguration(path, configuration);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readGitHubAppConfiguration(path)).not.toHaveProperty("client_secret");
    await expect(saveGitHubAppConfiguration(path, configuration)).rejects.toMatchObject({
      code: "EEXIST",
    });
    await chmod(path, 0o644);
    await expect(readGitHubAppConfiguration(path)).rejects.toThrow(
      "GITHUB_APP_PRIVATE_CONFIGURATION_INVALID",
    );
    await chmod(path, 0o600);
    const link = join(directory, "link.json");
    await symlink(path, link);
    await expect(readGitHubAppConfiguration(link)).rejects.toMatchObject({ code: "ELOOP" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
