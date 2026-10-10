import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  githubAppConfiguration,
  githubAppManifest,
  manifestCallbackCode,
} from "../scripts/github-app-manifest";

const nonce = "a".repeat(64);
describe("private read-only GitHub App setup", () => {
  it("prefills minimal permissions without user OAuth and uses the verified webhook endpoint", () => {
    const manifest = githubAppManifest(`http://127.0.0.1:4567/callback/${nonce}`);
    expect(manifest.public).toBe(false);
    expect(manifest.request_oauth_on_install).toBe(false);
    expect(manifest.default_permissions).toEqual({
      metadata: "read",
      checks: "read",
      pull_requests: "read",
    });
    expect(manifest.hook_attributes.url).toBe(
      "https://paca.howlearnwood.com/api/integrations/github/webhook",
    );
    expect(() => githubAppManifest(`https://evil.test/callback/${nonce}`)).toThrow(
      "GITHUB_APP_CALLBACK_INVALID",
    );
  });
  it("requires the callback nonce, one code and one state", () => {
    const code = "c".repeat(40);
    const valid = `http://127.0.0.1:4567/callback/${nonce}?code=${code}&state=${nonce}`;
    expect(manifestCallbackCode(new URL(valid), nonce)).toBe(code);
    for (const url of [
      valid.replace(nonce, "b".repeat(64)),
      `${valid}&code=${code}`,
      `${valid}&state=${nonce}`,
      valid.replace(`state=${nonce}`, "state=bad"),
      `${valid}&extra=x`,
    ])
      expect(() => manifestCallbackCode(new URL(url), nonce)).toThrow(
        "GITHUB_APP_CALLBACK_INVALID",
      );
  });
  it("validates the owner and RSA key, discards OAuth secrets and rejects broader permissions", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const input = {
      id: 1,
      slug: "paca-test",
      owner: { login: "yudi-xiao" },
      permissions: { metadata: "read", checks: "read", pull_requests: "read" },
      pem: privateKey.export({ format: "pem", type: "pkcs1" }).toString(),
      webhook_secret: "s".repeat(40),
      client_secret: "must-discard",
    };
    expect(githubAppConfiguration(input)).not.toHaveProperty("client_secret");
    expect(() => githubAppConfiguration({ ...input, owner: { login: "other" } })).toThrow(
      "GITHUB_APP_CONFIGURATION_INVALID",
    );
    expect(() =>
      githubAppConfiguration({ ...input, permissions: { ...input.permissions, contents: "read" } }),
    ).toThrow("GITHUB_APP_CONFIGURATION_INVALID");
    expect(() => githubAppConfiguration({ ...input, pem: "x".repeat(200) })).toThrow(
      "GITHUB_DELIVERY_APP_NOT_CONFIGURED",
    );
  });
});
