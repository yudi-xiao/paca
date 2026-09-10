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
const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENVIRONMENT_RETRY_MAX_ATTEMPTS = 3;
const ENVIRONMENT_RETRY_DEFAULT_DELAY_MS = 500;
const ENVIRONMENT_RETRY_MAX_DELAY_MS = 5_000;
const ENVIRONMENT_PREPARE_TIMEOUT_MS = 30_000;

type JsonRecord = Record<string, unknown>;

export type AgentGrantRequest = {
	capability: string;
	constraints: JsonRecord;
};

export type AgentCapabilityConfig = {
	version: 1;
	agentId: string;
	capabilities: string[];
	grantRequests: AgentGrantRequest[];
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

export type AgentAuthConfig = AgentCapabilityConfig & {
	providerOrigin: string;
	issuer: string;
	defaultLocation: string;
	hostId: string;
	agentId: string;
	agentName: string;
	keyAlgorithm: "Ed25519";
	publicKey: JsonWebKey;
	privateKey: JsonWebKey;
	registeredAt: string;
};

export type CapabilityBrokerConfig = AgentCapabilityConfig & {
	projectId: string;
};

export class AgentAuthClientError extends Error {
	constructor(
		readonly code: string,
		readonly retryable = false,
		readonly retryAfterMs?: number,
	) {
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

export function loadCapabilityBrokerConfig(
	encoded: string,
): CapabilityBrokerConfig {
	if (
		encoded.length === 0 ||
		encoded.length > MAX_CONFIG_BYTES * 2 ||
		!/^[A-Za-z0-9_-]+$/.test(encoded)
	) {
		throw new AgentAuthClientError("PACA_CAPABILITY_BROKER_CONFIG_INVALID");
	}
	let input: JsonRecord | null;
	try {
		const bytes = Buffer.from(encoded, "base64url");
		if (bytes.byteLength > MAX_CONFIG_BYTES)
			throw new Error("config too large");
		input = record(JSON.parse(bytes.toString("utf8")) as unknown);
	} catch {
		throw new AgentAuthClientError("PACA_CAPABILITY_BROKER_CONFIG_INVALID");
	}
	const expectedKeys = new Set([
		"version",
		"agentId",
		"projectId",
		"capabilities",
		"grantRequests",
	]);
	const capabilities = input?.capabilities;
	const requests = input?.grantRequests;
	if (
		!input ||
		Object.keys(input).some((key) => !expectedKeys.has(key)) ||
		input.version !== 1 ||
		!nonEmptyString(input.agentId) ||
		!nonEmptyString(input.projectId) ||
		!UUID.test(input.projectId) ||
		!Array.isArray(capabilities) ||
		capabilities.length === 0 ||
		capabilities.length > 64 ||
		capabilities.some((item) => !nonEmptyString(item, 128)) ||
		new Set(capabilities).size !== capabilities.length ||
		!Array.isArray(requests) ||
		requests.length === 0 ||
		requests.length > 64
	) {
		throw new AgentAuthClientError("PACA_CAPABILITY_BROKER_CONFIG_INVALID");
	}
	const grantRequests = requests.map((request) => {
		const item = record(request);
		const constraints = record(item?.constraints);
		if (
			!item ||
			Object.keys(item).some(
				(key) => key !== "capability" && key !== "constraints",
			) ||
			!nonEmptyString(item.capability, 128) ||
			!constraints ||
			!capabilities.includes(item.capability)
		) {
			throw new AgentAuthClientError("PACA_CAPABILITY_BROKER_CONFIG_INVALID");
		}
		return { capability: item.capability, constraints };
	});
	return {
		version: 1,
		agentId: input.agentId,
		projectId: input.projectId,
		capabilities: [...capabilities],
		grantRequests,
	};
}

function base64url(value: string | Uint8Array): string {
	return Buffer.from(value).toString("base64url");
}

function remoteError(
	body: unknown,
	status: number,
): { code: string; retryable: boolean; retryAfterMs?: number } {
	const value = record(body);
	let code = `AGENT_HTTP_${status}`;
	for (const candidate of [value?.code, value?.error_code, value?.error]) {
		if (typeof candidate === "string" && ERROR_CODE.test(candidate)) {
			code = candidate;
			break;
		}
	}
	const retryAfter = value?.retry_after_ms ?? value?.retryAfterMs;
	return {
		code,
		retryable: value?.retryable === true,
		...(typeof retryAfter === "number" &&
		Number.isInteger(retryAfter) &&
		retryAfter >= 100 &&
		retryAfter <= ENVIRONMENT_RETRY_MAX_DELAY_MS
			? { retryAfterMs: retryAfter }
			: {}),
	};
}

export class AgentAuthClient {
	constructor(
		readonly config: AgentAuthConfig,
		private readonly request: typeof fetch = fetch,
		private readonly now: () => Date = () => new Date(),
		private readonly wait: (milliseconds: number) => Promise<void> = (
			milliseconds,
		) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
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
		let response: Response;
		try {
			response = await this.request(url, {
				...init,
				headers,
				redirect: "error",
				signal: init.signal ?? AbortSignal.timeout(15_000),
			});
		} catch {
			throw new AgentAuthClientError(
				"AGENT_NETWORK_UNAVAILABLE",
				true,
				ENVIRONMENT_RETRY_DEFAULT_DELAY_MS,
			);
		}
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
		if (!response.ok) {
			const failure = remoteError(body, response.status);
			throw new AgentAuthClientError(
				failure.code,
				failure.retryable,
				failure.retryAfterMs,
			);
		}
		const envelope = record(body);
		return envelope && "data" in envelope ? envelope.data : body;
	}

	async execute(capability: string, arguments_: JsonRecord): Promise<unknown> {
		const execute = () =>
			this.jsonRequest(this.config.defaultLocation, [capability], {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ capability, arguments: arguments_ }),
			});
		if (capability !== "environment.connect") return execute();

		for (
			let attempt = 1;
			attempt <= ENVIRONMENT_RETRY_MAX_ATTEMPTS;
			attempt += 1
		) {
			try {
				const connection = await execute();
				await this.prepareEnvironmentConnection(connection);
				return connection;
			} catch (error) {
				if (
					!(error instanceof AgentAuthClientError) ||
					!error.retryable ||
					attempt === ENVIRONMENT_RETRY_MAX_ATTEMPTS
				) {
					throw error;
				}
				await this.wait(
					error.retryAfterMs ?? ENVIRONMENT_RETRY_DEFAULT_DELAY_MS,
				);
			}
		}
		throw new AgentAuthClientError("AGENT_ENVIRONMENT_RETRY_INVARIANT");
	}

	private async prepareEnvironmentConnection(value: unknown): Promise<void> {
		const connection = record(value);
		if (connection?.operationMode !== "execute") return;
		if (
			connection.protocolVersion !== "paca.environment.connection.v1" ||
			connection.transport !== "websocket" ||
			!nonEmptyString(connection.url, 2_048) ||
			!nonEmptyString(connection.accessToken, 4_096) ||
			!nonEmptyString(connection.environmentId) ||
			!nonEmptyString(connection.expiresAt)
		) {
			throw new AgentAuthClientError("AGENT_ENVIRONMENT_CONNECTION_INVALID");
		}

		let endpoint: URL;
		try {
			endpoint = new URL(connection.url);
			if (
				endpoint.protocol !== "wss:" ||
				endpoint.username ||
				endpoint.password ||
				endpoint.search ||
				endpoint.hash
			) {
				throw new Error("invalid environment URL");
			}
			endpoint.protocol = "https:";
		} catch {
			throw new AgentAuthClientError("AGENT_ENVIRONMENT_CONNECTION_INVALID");
		}

		const expiresAt = Date.parse(connection.expiresAt);
		if (!Number.isFinite(expiresAt) || expiresAt <= this.now().getTime()) {
			throw new AgentAuthClientError("AGENT_ENVIRONMENT_TICKET_EXPIRED", true);
		}
		let response: Response;
		try {
			response = await this.request(endpoint, {
				method: "POST",
				redirect: "error",
				headers: {
					accept: "application/json",
					authorization: `Bearer ${connection.accessToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ action: "prepare" }),
				signal: AbortSignal.timeout(ENVIRONMENT_PREPARE_TIMEOUT_MS),
			});
		} catch {
			throw new AgentAuthClientError(
				"AGENT_ENVIRONMENT_PREPARE_UNAVAILABLE",
				true,
				ENVIRONMENT_RETRY_DEFAULT_DELAY_MS,
			);
		}

		const contentType = response.headers
			.get("content-type")
			?.split(";", 1)[0]
			?.trim();
		const declaredHeader = response.headers.get("content-length");
		const declaredLength = declaredHeader === null ? 0 : Number(declaredHeader);
		if (
			contentType !== "application/json" ||
			!Number.isSafeInteger(declaredLength) ||
			declaredLength < 0 ||
			declaredLength > MAX_RESPONSE_BYTES
		) {
			void response.body?.cancel().catch(() => undefined);
			throw new AgentAuthClientError("AGENT_RESPONSE_INVALID");
		}
		let bytes: Uint8Array;
		try {
			bytes = new Uint8Array(await response.arrayBuffer());
		} catch {
			throw new AgentAuthClientError(
				"AGENT_ENVIRONMENT_PREPARE_UNAVAILABLE",
				true,
				ENVIRONMENT_RETRY_DEFAULT_DELAY_MS,
			);
		}
		if (bytes.byteLength > MAX_RESPONSE_BYTES) {
			throw new AgentAuthClientError("AGENT_RESPONSE_INVALID");
		}
		let body: unknown;
		try {
			body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
		} catch {
			throw new AgentAuthClientError("AGENT_RESPONSE_INVALID");
		}
		if (!response.ok) {
			const failure = remoteError(body, response.status);
			throw new AgentAuthClientError(
				failure.code,
				failure.retryable,
				failure.retryAfterMs,
			);
		}
		const ready = record(body);
		if (
			ready?.status !== "ready" ||
			ready.environmentId !== connection.environmentId
		) {
			throw new AgentAuthClientError("AGENT_ENVIRONMENT_PREPARE_INVALID");
		}
	}

	async requestAgent(
		path: string,
		capabilities: string[],
		init: RequestInit,
	): Promise<unknown> {
		if (
			!path.startsWith("/api/v1/agent/") ||
			path.includes("//") ||
			path.includes("?") ||
			path.includes("#")
		) {
			throw new AgentAuthClientError("AGENT_REQUEST_PATH_INVALID");
		}
		const target = new URL(path, this.config.providerOrigin);
		if (target.origin !== this.config.providerOrigin) {
			throw new AgentAuthClientError("AGENT_REQUEST_PATH_INVALID");
		}
		return this.jsonRequest(target.toString(), capabilities, init);
	}

	async discoverTasks(): Promise<unknown> {
		return this.requestAgent(
			"/api/v1/agent/tasks/claimable",
			["task.execute"],
			{
				method: "GET",
			},
		);
	}

	async heartbeat(report: AgentHeartbeatReport): Promise<unknown> {
		return this.requestAgent("/api/v1/agent/host/heartbeat", ["task.execute"], {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(report),
		});
	}
}

export class CapabilityBrokerClient {
	readonly config: CapabilityBrokerConfig;
	private readonly endpoint: string;

	constructor(
		config: CapabilityBrokerConfig,
		endpoint: string,
		private readonly token: string,
		private readonly request: typeof fetch = fetch,
	) {
		this.config = config;
		let parsed: URL;
		try {
			parsed = new URL(endpoint);
		} catch {
			throw new AgentAuthClientError("PACA_CAPABILITY_BROKER_CONFIG_INVALID");
		}
		if (
			(parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
			parsed.username ||
			parsed.password ||
			parsed.search ||
			parsed.hash ||
			!/^[-_A-Za-z0-9]{43}$/.test(token)
		) {
			throw new AgentAuthClientError("PACA_CAPABILITY_BROKER_CONFIG_INVALID");
		}
		this.endpoint = parsed.toString();
	}

	private async brokerRequest(payload: JsonRecord): Promise<unknown> {
		let response: Response;
		try {
			response = await this.request(this.endpoint, {
				method: "POST",
				redirect: "error",
				headers: {
					accept: "application/json",
					authorization: `Bearer ${this.token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(15_000),
			});
		} catch {
			throw new AgentAuthClientError("CAPABILITY_BROKER_UNAVAILABLE", true);
		}
		const declaredHeader = response.headers.get("content-length");
		const declaredLength = declaredHeader === null ? 0 : Number(declaredHeader);
		const contentType = response.headers
			.get("content-type")
			?.split(";", 1)[0]
			?.trim();
		if (
			contentType !== "application/json" ||
			!Number.isSafeInteger(declaredLength) ||
			declaredLength < 0 ||
			declaredLength > MAX_RESPONSE_BYTES
		) {
			void response.body?.cancel().catch(() => undefined);
			throw new AgentAuthClientError("CAPABILITY_BROKER_RESPONSE_INVALID");
		}
		let bytes: Uint8Array;
		try {
			bytes = new Uint8Array(await response.arrayBuffer());
		} catch {
			throw new AgentAuthClientError("CAPABILITY_BROKER_UNAVAILABLE", true);
		}
		if (bytes.byteLength > MAX_RESPONSE_BYTES) {
			throw new AgentAuthClientError("CAPABILITY_BROKER_RESPONSE_INVALID");
		}
		let body: unknown;
		try {
			body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
		} catch {
			throw new AgentAuthClientError("CAPABILITY_BROKER_RESPONSE_INVALID");
		}
		if (!response.ok) {
			const failure = remoteError(body, response.status);
			throw new AgentAuthClientError(
				failure.code,
				failure.retryable,
				failure.retryAfterMs,
			);
		}
		const envelope = record(body);
		return envelope && "data" in envelope ? envelope.data : body;
	}

	async execute(capability: string, arguments_: JsonRecord): Promise<unknown> {
		if (!this.config.capabilities.includes(capability)) {
			throw new AgentAuthClientError("AGENT_CAPABILITY_NOT_REQUESTED");
		}
		return await this.brokerRequest({
			operation: "execute",
			capability,
			arguments: arguments_,
		});
	}

	async requestAgent(
		path: string,
		capabilities: string[],
		init: RequestInit,
	): Promise<unknown> {
		const segments = path.split("/");
		if (
			!path.startsWith(`/api/v1/agent/projects/${this.config.projectId}/`) ||
			path.includes("//") ||
			path.includes("?") ||
			path.includes("#") ||
			path.includes("%") ||
			segments.includes(".") ||
			segments.includes("..") ||
			capabilities.length === 0 ||
			new Set(capabilities).size !== capabilities.length ||
			capabilities.some(
				(capability) => !this.config.capabilities.includes(capability),
			)
		) {
			throw new AgentAuthClientError("AGENT_REQUEST_PATH_INVALID");
		}
		const method = init.method?.toUpperCase() ?? "GET";
		if (!new Set(["GET", "POST", "DELETE"]).has(method)) {
			throw new AgentAuthClientError("AGENT_REQUEST_PATH_INVALID");
		}
		let body: unknown = null;
		if (init.body !== undefined && init.body !== null) {
			try {
				body = JSON.parse(String(init.body)) as unknown;
			} catch {
				throw new AgentAuthClientError("AGENT_REQUEST_BODY_INVALID");
			}
		}
		return await this.brokerRequest({
			operation: "agent_request",
			method,
			path,
			capabilities,
			body,
		});
	}

	async discoverTasks(): Promise<unknown> {
		throw new AgentAuthClientError("CAPABILITY_BROKER_OPERATION_DENIED");
	}

	async heartbeat(_report: AgentHeartbeatReport): Promise<unknown> {
		throw new AgentAuthClientError("CAPABILITY_BROKER_OPERATION_DENIED");
	}
}

export function exactConstraint(value: unknown): string | null {
	return nonEmptyString(value) ? value : null;
}
