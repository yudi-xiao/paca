import { chmod, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentHostEnrollmentError,
  canonicalAgentHostOrigin,
  enrollAgentHost,
  validateAgentAuthDiscovery,
  validateEnrollmentToken,
  writeAgentHostConfig,
} from "../src/agent-auth/host-enrollment";

const origin = "https://paca.howlearnwood.com";
const discovery = {
  issuer: `${origin}/api/auth`,
  default_location: `${origin}/api/auth/capability/execute`,
  algorithms: ["Ed25519"],
  modes: ["delegated"],
};

afterEach(() => vi.restoreAllMocks());

describe("Agent Host enrollment", () => {
  it("accepts only a canonical HTTPS provider origin", () => {
    expect(canonicalAgentHostOrigin(origin)).toBe(origin);
    for (const invalid of [`http://paca.test`, `${origin}/api`, `https://user@paca.test`]) {
      expect(() => canonicalAgentHostOrigin(invalid)).toThrowError(
        expect.objectContaining({ code: "PACA_AGENT_HOST_ORIGIN_INVALID" }),
      );
    }
  });

  it("pins discovery issuer and execution endpoint to the provider origin", () => {
    expect(validateAgentAuthDiscovery(discovery, origin)).toMatchObject(discovery);
    expect(() =>
      validateAgentAuthDiscovery(
        { ...discovery, issuer: "https://attacker.test/api/auth" },
        origin,
      ),
    ).toThrowError(expect.objectContaining({ code: "AGENT_AUTH_DISCOVERY_ORIGIN_MISMATCH" }));
  });

  it("rejects malformed enrollment tokens without logging their value", () => {
    expect(validateEnrollmentToken("a-valid-looking-token-with-enough-entropy")).toBe(
      "a-valid-looking-token-with-enough-entropy",
    );
    expect(() => validateEnrollmentToken("short")).toThrow(AgentHostEnrollmentError);
    expect(() => validateEnrollmentToken("contains whitespace token")).toThrow(
      AgentHostEnrollmentError,
    );
  });

  it("discovers, enrolls with a public Ed25519 JWK, and keeps the private key local", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/.well-known/agent-configuration")) {
        return Response.json(discovery);
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.token).toBe("one-time-enrollment-token-12345");
      expect(body.public_key).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA" });
      expect(body.public_key).not.toHaveProperty("d");
      return Response.json({ hostId: "host-1", name: "Paca Host", status: "active" });
    });

    const config = await enrollAgentHost({
      providerOrigin: origin,
      enrollmentToken: "one-time-enrollment-token-12345",
      fetch: fetchMock as typeof fetch,
      now: () => new Date("2026-08-31T00:00:00.000Z"),
    });

    expect(config).toMatchObject({
      version: 1,
      providerOrigin: origin,
      issuer: `${origin}/api/auth`,
      defaultLocation: `${origin}/api/auth/capability/execute`,
      hostId: "host-1",
      hostName: "Paca Host",
      keyAlgorithm: "Ed25519",
      enrolledAt: "2026-08-31T00:00:00.000Z",
    });
    expect(config.publicKey).not.toHaveProperty("d");
    expect(config.privateKey.d).toEqual(expect.any(String));
  });

  it("writes one immutable 0600 config file and refuses to overwrite it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paca-agent-host-"));
    const path = join(directory, "nested", "agent-host.json");
    const config = {
      version: 1 as const,
      providerOrigin: origin,
      issuer: `${origin}/api/auth`,
      defaultLocation: `${origin}/api/auth/capability/execute`,
      hostId: "host-1",
      hostName: "Paca Host",
      keyAlgorithm: "Ed25519" as const,
      publicKey: { kty: "OKP", crv: "Ed25519", x: "public" },
      privateKey: { kty: "OKP", crv: "Ed25519", x: "public", d: "private" },
      enrolledAt: "2026-08-31T00:00:00.000Z",
    };
    await writeAgentHostConfig(path, config);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(config);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await chmod(path, 0o644);
    await expect(writeAgentHostConfig(path, config)).rejects.toMatchObject({
      code: "AGENT_HOST_CONFIG_ALREADY_EXISTS",
    });
  });
});
