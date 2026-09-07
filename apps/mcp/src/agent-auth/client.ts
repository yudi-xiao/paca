import {
	createPrivateKey,
	createPublicKey,
	randomUUID,
	sign,
} from "node:crypto";
import { lstat, readFile } from "node:fs/promises";

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/;

type JsonRecord = Record<string, unknown>;

export type AgentGrantRequest = {
	capability: string;
	constraints: JsonRecord;
};

export const agentHarnessKinds = [
	"cloudflare-agent",
	"codex",
	"claude-code",
	"deepseek",
	"custom",
] as const;

export type AgentHarnessKind = (typeof agentHarnessKinds)[number];

export type AgentHeartbeatReport = {
	harnesses: Array<{
		kind: AgentHarnessKind;
		version?: string;
		instanceId?: string;
	}>;
	labels: string[];
};

export type AgentAuthConfig = {
	version: 1;
	providerOrigin: string;
	issuer: string;
	defaultLocation: string;
	hostId: string;
	agentId: string;
	agentName: string;
	keyAlgorithm: "Ed25519";
	publicKey: JsonWebKey;
	privateKey: JsonWebKey;
	capabilities: string[];
	grantRequests: AgentGrantRequest[];
	registeredAt: string;
};

export class AgentAuthClientError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = "AgentAuthClientError";
	}
}

const HOST_LABEL = /^[a-z0-9][a-z0-9._:-]*$/;

export function createAgentHeartbeatReport(input: {
	kind?: string;
	version?: string;
	instanceId?: string;
}): AgentHeartbeatReport {
	const kind = input.kind ?? "custom";
	if (
		!agentHarnessKinds.includes(kind as AgentHarnessKind) ||
		(input.version !== undefined && input.version.length > 100) ||
		(input.instanceId !== undefined && input.instanceId.length > 255)
	) {
		throw new AgentAuthClientError("PACA_AGENT_HARNESS_INVALID");
	}
	const labels = ["task:execute"];
	if (labels.some((label) => label.length > 64 || !HOST_LABEL.test(label))) {
		throw new AgentAuthClientError("PACA_AGENT_HARNESS_INVALID");
	}
	return {
		harnesses: [
			{
				kind: kind as AgentHarnessKind,
				...(input.version ? { version: input.version } : {}),
				...(input.instanceId ? { instanceId: input.instanceId } : {}),
			},
		],
		labels,
	};
}

function record(value: unknown): JsonRecord | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonRecord)
		: null;
}

function nonEmptyString(value: unknown, max = 255): value is string {
	return (
		typeof value === "string" &&
		value.trim() === value &&
		value.length > 0 &&
		value.length <= max
	);
}

function exactEndpoint(
	value: unknown,
	origin: string,
	pathname: string,
): value is string {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		return (
			url.origin === origin &&
			url.pathname === pathname &&
			url.username === "" &&
			url.password === "" &&
			url.search === "" &&
			url.hash === ""
		);
	} catch {
		return false;
	}
}

function providerOrigin(value: unknown): string | null {
	if (typeof value !== "string") return null;
	try {
		const url = new URL(value);
		if (
			url.protocol !== "https:" ||
			url.username !== "" ||
			url.password !== "" ||
			url.pathname !== "/" ||
			url.search !== "" ||
			url.hash !== "" ||
			value !== url.origin
		) {
			return null;
		}
		return url.origin;
	} catch {
		return null;
	}
}

function validateJwk(
	value: unknown,
	operation: "sign" | "verify",
): JsonWebKey | null {
	const jwk = record(value);
	if (
		jwk?.kty !== "OKP" ||
		jwk.crv !== "Ed25519" ||
		!nonEmptyString(jwk.x, 100) ||
		(operation === "sign"
			? !nonEmptyString(jwk.d, 100)
			: jwk.d !== undefined) ||
		(jwk.alg !== undefined && jwk.alg !== null && jwk.alg !== "EdDSA") ||
		(jwk.use !== undefined && jwk.use !== null && jwk.use !== "sig")
	) {
		return null;
	}
	if (
		jwk.key_ops !== undefined &&
		(!Array.isArray(jwk.key_ops) ||
			jwk.key_ops.length !== 1 ||
			jwk.key_ops[0] !== operation)
	) {
		return null;
	}
	return jwk as JsonWebKey;
}

function parseConfig(value: unknown): AgentAuthConfig {
	const input = record(value);
	const origin = providerOrigin(input?.providerOrigin);
	const publicKey = validateJwk(input?.publicKey, "verify");
	const privateKey = validateJwk(input?.privateKey, "sign");
	const capabilities = input?.capabilities;
	const requests = input?.grantRequests;
	if (
		input?.version !== 1 ||
		input.keyAlgorithm !== "Ed25519" ||
		!origin ||
		!exactEndpoint(input.issuer, origin, "/api/auth") ||
		!exactEndpoint(
			input.defaultLocation,
			origin,
			"/api/auth/capability/execute",
		) ||
		!nonEmptyString(input.hostId) ||
		!nonEmptyString(input.agentId) ||
		!nonEmptyString(input.agentName, 500) ||
		!publicKey ||
		!privateKey ||
		!Array.isArray(capabilities) ||
		capabilities.length === 0 ||
		capabilities.length > 64 ||
		capabilities.some((item) => !nonEmptyString(item, 128)) ||
		new Set(capabilities).size !== capabilities.length ||
		!Array.isArray(requests) ||
		requests.length === 0 ||
		Number.isNaN(Date.parse(String(input.registeredAt ?? "")))
	) {
		throw new AgentAuthClientError("PACA_AGENT_CONFIG_INVALID");
	}
	const grantRequests = requests.map((request) => {
		const item = record(request);
		const constraints = record(item?.constraints);
		if (
			!nonEmptyString(item?.capability, 128) ||
			!constraints ||
			!capabilities.includes(item.capability)
		) {
			throw new AgentAuthClientError("PACA_AGENT_CONFIG_INVALID");
		}
		return { capability: item.capability, constraints };
	});
	try {
		const privateObject = createPrivateKey({ key: privateKey, format: "jwk" });
		const derived = createPublicKey(privateObject).export({ format: "jwk" });
		if (derived.x !== publicKey.x || privateKey.x !== publicKey.x) {
			throw new AgentAuthClientError("PACA_AGENT_CONFIG_INVALID");
		}
	} catch (error) {
		if (error instanceof AgentAuthClientError) throw error;
		throw new AgentAuthClientError("PACA_AGENT_CONFIG_INVALID");
	}
	return {
		version: 1,
		providerOrigin: origin,
		issuer: input.issuer,
		defaultLocation: input.defaultLocation,
		hostId: input.hostId,
		agentId: input.agentId,
		agentName: input.agentName,
		keyAlgorithm: "Ed25519",
		publicKey,
		privateKey,
		capabilities: [...capabilities],
		grantRequests,
		registeredAt: String(input.registeredAt),
	};
}

export async function loadAgentAuthConfig(
	path: string,
): Promise<AgentAuthConfig> {
	let info: Awaited<ReturnType<typeof lstat>>;
	try {
		info = await lstat(path);
	} catch {
		throw new AgentAuthClientError("PACA_AGENT_CONFIG_INVALID");
	}
	if (
		!info.isFile() ||
		info.isSymbolicLink() ||
		(info.mode & 0o077) !== 0 ||
		info.size > MAX_CONFIG_BYTES
	) {
		throw new AgentAuthClientError("PACA_AGENT_CONFIG_PERMISSIONS_INVALID");
	}
	let contents: string;
	try {
		contents = await readFile(path, "utf8");
	} catch {
		throw new AgentAuthClientError("PACA_AGENT_CONFIG_INVALID");
	}
	if (Buffer.byteLength(contents) > MAX_CONFIG_BYTES) {
		throw new AgentAuthClientError("PACA_AGENT_CONFIG_INVALID");
	}
	try {
		return parseConfig(JSON.parse(contents) as unknown);
	} catch (error) {
		if (error instanceof AgentAuthClientError) throw error;
		throw new AgentAuthClientError("PACA_AGENT_CONFIG_INVALID");
	}
}

function base64url(value: string | Uint8Array): string {
	return Buffer.from(value).toString("base64url");
}

function remoteError(body: unknown, status: number): string {
	const value = record(body);
	for (const candidate of [value?.code, value?.error_code, value?.error]) {
		if (typeof candidate === "string" && ERROR_CODE.test(candidate))
			return candidate;
	}
	return `AGENT_HTTP_${status}`;
}

export class AgentAuthClient {
	constructor(
		readonly config: AgentAuthConfig,
		private readonly request: typeof fetch = fetch,
		private readonly now: () => Date = () => new Date(),
	) {}

	private jwt(capabilities: string[]): string {
		if (
			capabilities.length === 0 ||
			new Set(capabilities).size !== capabilities.length ||
			capabilities.some(
				(capability) => !this.config.capabilities.includes(capability),
			)
		) {
			throw new AgentAuthClientError("AGENT_CAPABILITY_NOT_REQUESTED");
		}
		const issuedAt = Math.floor(this.now().getTime() / 1_000);
		const header = base64url(
			JSON.stringify({ alg: "EdDSA", typ: "agent+jwt" }),
		);
		const payload = base64url(
			JSON.stringify({
				capabilities,
				iss: this.config.hostId,
				sub: this.config.agentId,
				aud: this.config.defaultLocation,
				jti: randomUUID(),
				iat: issuedAt,
				exp: issuedAt + 45,
			}),
		);
		const unsigned = `${header}.${payload}`;
		const signature = sign(
			null,
			Buffer.from(unsigned),
			createPrivateKey({ key: this.config.privateKey, format: "jwk" }),
		);
		return `${unsigned}.${base64url(signature)}`;
	}

	private async jsonRequest(
		url: string,
		capabilities: string[],
		init: RequestInit,
	): Promise<unknown> {
		const headers = new Headers(init.headers);
		headers.set("accept", "application/json");
		headers.set("authorization", `Bearer ${this.jwt(capabilities)}`);
		const response = await this.request(url, {
			...init,
			headers,
			redirect: "error",
			signal: init.signal ?? AbortSignal.timeout(15_000),
		});
		const declaredLength = Number(response.headers.get("content-length") ?? 0);
		if (declaredLength > MAX_RESPONSE_BYTES) {
			throw new AgentAuthClientError("AGENT_RESPONSE_INVALID");
		}
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > MAX_RESPONSE_BYTES) {
			throw new AgentAuthClientError("AGENT_RESPONSE_INVALID");
		}
		let body: unknown = null;
		try {
			body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
		} catch {
			throw new AgentAuthClientError("AGENT_RESPONSE_INVALID");
		}
		if (!response.ok)
			throw new AgentAuthClientError(remoteError(body, response.status));
		const envelope = record(body);
		return envelope && "data" in envelope ? envelope.data : body;
	}

	async execute(capability: string, arguments_: JsonRecord): Promise<unknown> {
		return this.jsonRequest(this.config.defaultLocation, [capability], {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ capability, arguments: arguments_ }),
		});
	}

	async discoverTasks(): Promise<unknown> {
		return this.jsonRequest(
			`${this.config.providerOrigin}/api/v1/agent/tasks/claimable`,
			["task.execute"],
			{ method: "GET" },
		);
	}

	async heartbeat(report: AgentHeartbeatReport): Promise<unknown> {
		return this.jsonRequest(
			`${this.config.providerOrigin}/api/v1/agent/host/heartbeat`,
			["task.execute"],
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(report),
			},
		);
	}
}

export function exactConstraint(value: unknown): string | null {
	return nonEmptyString(value) ? value : null;
}
