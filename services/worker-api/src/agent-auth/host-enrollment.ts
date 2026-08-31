import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const ED25519_ALGORITHM = "Ed25519";
const MAX_ENROLLMENT_TOKEN_LENGTH = 512;

type JsonRecord = Record<string, unknown>;

export type AgentAuthDiscovery = {
  issuer: string;
  default_location: string;
  algorithms: string[];
  modes: string[];
};

export type AgentHostConfig = {
  version: 1;
  providerOrigin: string;
  issuer: string;
  defaultLocation: string;
  hostId: string;
  hostName: string | null;
  keyAlgorithm: "Ed25519";
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
  enrolledAt: string;
};

export class AgentHostEnrollmentError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AgentHostEnrollmentError";
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

export function canonicalAgentHostOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AgentHostEnrollmentError("PACA_AGENT_HOST_ORIGIN_INVALID");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new AgentHostEnrollmentError("PACA_AGENT_HOST_ORIGIN_INVALID");
  }
  return parsed.origin;
}

function sameOriginURL(value: unknown, origin: string, expectedPath: string): string {
  if (typeof value !== "string") {
    throw new AgentHostEnrollmentError("AGENT_AUTH_DISCOVERY_INVALID");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AgentHostEnrollmentError("AGENT_AUTH_DISCOVERY_INVALID");
  }
  if (
    parsed.origin !== origin ||
    parsed.pathname !== expectedPath ||
    parsed.search ||
    parsed.hash
  ) {
    throw new AgentHostEnrollmentError("AGENT_AUTH_DISCOVERY_ORIGIN_MISMATCH");
  }
  return parsed.toString();
}

export function validateAgentAuthDiscovery(
  value: unknown,
  providerOrigin: string,
): AgentAuthDiscovery {
  const discovery = asRecord(value);
  if (!discovery) throw new AgentHostEnrollmentError("AGENT_AUTH_DISCOVERY_INVALID");
  const issuer = sameOriginURL(discovery.issuer, providerOrigin, "/api/auth").replace(/\/$/, "");
  const defaultLocation = sameOriginURL(
    discovery.default_location,
    providerOrigin,
    "/api/auth/capability/execute",
  );
  const algorithms = Array.isArray(discovery.algorithms)
    ? discovery.algorithms.filter((value): value is string => typeof value === "string")
    : [];
  const modes = Array.isArray(discovery.modes)
    ? discovery.modes.filter((value): value is string => typeof value === "string")
    : [];
  if (!algorithms.includes(ED25519_ALGORITHM) || !modes.includes("delegated")) {
    throw new AgentHostEnrollmentError("AGENT_AUTH_DISCOVERY_UNSUPPORTED");
  }
  return {
    issuer,
    default_location: defaultLocation,
    algorithms,
    modes,
  };
}

function base64url(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64url");
}

async function jwkThumbprint(publicKey: JsonWebKey): Promise<string> {
  if (publicKey.kty !== "OKP" || publicKey.crv !== "Ed25519" || !publicKey.x) {
    throw new AgentHostEnrollmentError("AGENT_HOST_PUBLIC_KEY_INVALID");
  }
  const canonical = JSON.stringify({ crv: publicKey.crv, kty: publicKey.kty, x: publicKey.x });
  return base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
}

export async function generateAgentHostIdentity(): Promise<{
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
}> {
  const pair = (await crypto.subtle.generateKey({ name: ED25519_ALGORITHM }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const [publicKey, privateKey] = await Promise.all([
    crypto.subtle.exportKey("jwk", pair.publicKey),
    crypto.subtle.exportKey("jwk", pair.privateKey),
  ]);
  const kid = await jwkThumbprint(publicKey);
  const common = { alg: "EdDSA", use: "sig", kid };
  return {
    publicKey: { ...publicKey, ...common },
    privateKey: { ...privateKey, ...common },
  };
}

export function validateEnrollmentToken(value: string): string {
  const token = value.trim();
  if (token.length < 20 || token.length > MAX_ENROLLMENT_TOKEN_LENGTH || /\s/.test(token)) {
    throw new AgentHostEnrollmentError("AGENT_HOST_ENROLLMENT_TOKEN_INVALID");
  }
  return token;
}

async function jsonOrNull(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("application/json") ? response.json().catch(() => null) : null;
}

export async function enrollAgentHost(input: {
  providerOrigin: string;
  enrollmentToken: string;
  fetch?: typeof fetch;
  now?: () => Date;
}): Promise<AgentHostConfig> {
  const providerOrigin = canonicalAgentHostOrigin(input.providerOrigin);
  const enrollmentToken = validateEnrollmentToken(input.enrollmentToken);
  const request = input.fetch ?? fetch;
  const discoveryResponse = await request(`${providerOrigin}/.well-known/agent-configuration`, {
    headers: { accept: "application/json" },
    redirect: "error",
  });
  if (!discoveryResponse.ok) {
    throw new AgentHostEnrollmentError(`AGENT_AUTH_DISCOVERY_HTTP_${discoveryResponse.status}`);
  }
  const discovery = validateAgentAuthDiscovery(await jsonOrNull(discoveryResponse), providerOrigin);
  const identity = await generateAgentHostIdentity();
  const enrollmentResponse = await request(`${discovery.issuer}/host/enroll`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ token: enrollmentToken, public_key: identity.publicKey }),
    redirect: "error",
  });
  const body = asRecord(await jsonOrNull(enrollmentResponse));
  if (!enrollmentResponse.ok) {
    const remoteCode = body?.code ?? body?.error;
    throw new AgentHostEnrollmentError(
      typeof remoteCode === "string"
        ? `AGENT_HOST_ENROLLMENT_${remoteCode}`
        : `AGENT_HOST_ENROLLMENT_HTTP_${enrollmentResponse.status}`,
    );
  }
  if (typeof body?.hostId !== "string" || body.hostId.length === 0 || body.status !== "active") {
    throw new AgentHostEnrollmentError("AGENT_HOST_ENROLLMENT_RESPONSE_INVALID");
  }
  if (typeof identity.privateKey.d !== "string" || identity.privateKey.d.length === 0) {
    throw new AgentHostEnrollmentError("AGENT_HOST_PRIVATE_KEY_INVALID");
  }
  return {
    version: 1,
    providerOrigin,
    issuer: discovery.issuer,
    defaultLocation: discovery.default_location,
    hostId: body.hostId,
    hostName: typeof body.name === "string" ? body.name : null,
    keyAlgorithm: ED25519_ALGORITHM,
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
    enrolledAt: (input.now ?? (() => new Date()))().toISOString(),
  };
}

export async function assertAgentHostConfigAbsent(path: string): Promise<void> {
  try {
    await stat(path);
    throw new AgentHostEnrollmentError("AGENT_HOST_CONFIG_ALREADY_EXISTS");
  } catch (error) {
    if (error instanceof AgentHostEnrollmentError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function writeAgentHostConfig(path: string, config: AgentHostConfig): Promise<void> {
  return writePrivateJsonConfig(path, config);
}

export async function writePrivateJsonConfig(path: string, value: unknown): Promise<void> {
  await assertAgentHostConfigAbsent(path);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
