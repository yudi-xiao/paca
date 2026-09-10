import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AgentAuthClient,
	AgentAuthClientError,
	CapabilityBrokerClient,
	createAgentHeartbeatReport,
	loadAgentAuthConfig,
	loadCapabilityBrokerConfig,
} from "../../agent-auth/client.js";

const tempDirectories: string[] = [];

function configJson() {
	const pair = generateKeyPairSync("ed25519");
	const publicKey = pair.publicKey.export({ format: "jwk" });
	const privateKey = pair.privateKey.export({ format: "jwk" });
	return {
		config: {
			version: 1,
			providerOrigin: "https://paca.example.com",
			issuer: "https://paca.example.com/api/auth",
			defaultLocation: "https://paca.example.com/api/auth/capability/execute",
			hostId: "host-1",
			agentId: "agent-1",
			agentName: "Codex",
			keyAlgorithm: "Ed25519",
			publicKey,
			privateKey,
			capabilities: ["project.read", "task.execute", "environment.connect"],
			grantRequests: [
				{
					capability: "project.read",
					constraints: {
						organizationId: "org-1",
						projectId: "11111111-1111-4111-8111-111111111111",
						validUntil: "2099-01-01T00:00:00.000Z",
					},
				},
				{
					capability: "task.execute",
					constraints: {
						organizationId: "org-1",
						projectId: "11111111-1111-4111-8111-111111111111",
						validUntil: "2099-01-01T00:00:00.000Z",
					},
				},
				{
					capability: "environment.connect",
					constraints: {
						organizationId: "org-1",
						projectId: "11111111-1111-4111-8111-111111111111",
						environmentId: "22222222-2222-4222-8222-222222222222",
						operationMode: "execute",
						validUntil: "2099-01-01T00:00:00.000Z",
					},
				},
			],
			registeredAt: "2026-09-01T00:00:00.000Z",
		},
		publicKey,
	};
}

async function writeConfig(mode = 0o600) {
	const directory = await mkdtemp(join(tmpdir(), "paca-mcp-agent-auth-"));
	tempDirectories.push(directory);
	const path = join(directory, "agent.json");
	const fixture = configJson();
	await writeFile(path, JSON.stringify(fixture.config), { mode });
	await chmod(path, mode);
	return { path, ...fixture };
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		tempDirectories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("Agent Auth MCP client", () => {
	it("loads a public Project-scoped Capability Broker envelope", () => {
		const encoded = Buffer.from(
			JSON.stringify({
				version: 1,
				agentId: "agent-1",
				projectId: "11111111-1111-4111-8111-111111111111",
				capabilities: ["project.read"],
				grantRequests: [
					{
						capability: "project.read",
						constraints: {
							organizationId: "org-1",
							projectId: "11111111-1111-4111-8111-111111111111",
							validUntil: "2099-01-01T00:00:00.000Z",
						},
					},
				],
			}),
		).toString("base64url");
		expect(loadCapabilityBrokerConfig(encoded)).toMatchObject({
			agentId: "agent-1",
			projectId: "11111111-1111-4111-8111-111111111111",
			capabilities: ["project.read"],
		});
		expect(() => loadCapabilityBrokerConfig("not+base64url")).toThrow(
			"PACA_CAPABILITY_BROKER_CONFIG_INVALID",
		);
	});

	it("uses only the opaque broker bearer and enforces its Project boundary", async () => {
		const config = loadCapabilityBrokerConfig(
			Buffer.from(
				JSON.stringify({
					version: 1,
					agentId: "agent-1",
					projectId: "11111111-1111-4111-8111-111111111111",
					capabilities: ["project.read", "workflow.execute"],
					grantRequests: [
						{
							capability: "project.read",
							constraints: {
								organizationId: "org-1",
								projectId: "11111111-1111-4111-8111-111111111111",
								validUntil: "2099-01-01T00:00:00.000Z",
							},
						},
						{
							capability: "workflow.execute",
							constraints: {
								organizationId: "org-1",
								projectId: "11111111-1111-4111-8111-111111111111",
								validUntil: "2099-01-01T00:00:00.000Z",
							},
						},
					],
				}),
			).toString("base64url"),
		);
		const token = "x".repeat(43);
		const request = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) => {
				expect(new Headers(init?.headers).get("authorization")).toBe(
					`Bearer ${token}`,
				);
				return Response.json({ data: { ok: true } });
			},
		);
		const client = new CapabilityBrokerClient(
			config,
			"http://agent-runner:8080/agent-capabilities",
			token,
			request as typeof fetch,
		);

		await expect(
			client.execute("project.read", {
				projectId: "11111111-1111-4111-8111-111111111111",
			}),
		).resolves.toEqual({ ok: true });
		expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
			operation: "execute",
			capability: "project.read",
			arguments: { projectId: "11111111-1111-4111-8111-111111111111" },
		});
		await expect(
			client.requestAgent(
				"/api/v1/agent/projects/22222222-2222-4222-8222-222222222222/runs",
				["workflow.execute"],
				{ method: "POST" },
			),
		).rejects.toMatchObject({ code: "AGENT_REQUEST_PATH_INVALID" });
		for (const path of [
			"/api/v1/agent/projects/11111111-1111-4111-8111-111111111111/../tasks",
			"/api/v1/agent/projects/11111111-1111-4111-8111-111111111111/%2e%2e/tasks",
		]) {
			await expect(
				client.requestAgent(path, ["workflow.execute"], { method: "GET" }),
			).rejects.toMatchObject({ code: "AGENT_REQUEST_PATH_INVALID" });
		}
		expect(request).toHaveBeenCalledOnce();
	});

	it("loads only a private regular 0600 identity file", async () => {
		const fixture = await writeConfig();
		await expect(loadAgentAuthConfig(fixture.path)).resolves.toMatchObject({
			hostId: "host-1",
			agentId: "agent-1",
			providerOrigin: "https://paca.example.com",
		});

		await chmod(fixture.path, 0o644);
		await expect(loadAgentAuthConfig(fixture.path)).rejects.toMatchObject({
			code: "PACA_AGENT_CONFIG_PERMISSIONS_INVALID",
		});
	});

	it("rejects a symlink before reading private key material", async () => {
		const fixture = await writeConfig();
		const link = join(fixture.path, "..", "linked-agent.json");
		await symlink(fixture.path, link);
		await expect(loadAgentAuthConfig(link)).rejects.toMatchObject({
			code: "PACA_AGENT_CONFIG_PERMISSIONS_INVALID",
		});
	});

	it("signs a fresh, short-lived Agent JWT for every request", async () => {
		const fixture = await writeConfig();
		const config = await loadAgentAuthConfig(fixture.path);
		const tokens: string[] = [];
		const request = vi.fn(
			async (_input: string | URL | Request, init?: RequestInit) => {
				tokens.push(
					new Headers(init?.headers)
						.get("authorization")
						?.replace("Bearer ", "") ?? "",
				);
				return new Response(JSON.stringify({ data: { id: "project-1" } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		);
		const client = new AgentAuthClient(
			config,
			request as typeof fetch,
			() => new Date("2026-09-02T08:00:00.000Z"),
		);

		await client.execute("project.read", { projectId: "project-1" });
		await client.execute("project.read", { projectId: "project-1" });

		expect(tokens).toHaveLength(2);
		expect(tokens[0]).not.toBe(tokens[1]);
		for (const token of tokens) {
			const [header, payload, signature] = token.split(".");
			expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
				alg: "EdDSA",
				typ: "agent+jwt",
			});
			expect(
				JSON.parse(Buffer.from(payload, "base64url").toString()),
			).toMatchObject({
				iss: "host-1",
				sub: "agent-1",
				aud: "https://paca.example.com/api/auth/capability/execute",
				capabilities: ["project.read"],
				iat: 1_788_336_000,
				exp: 1_788_336_045,
			});
			expect(
				verify(
					null,
					Buffer.from(`${header}.${payload}`),
					createPublicKey({ key: fixture.publicKey, format: "jwk" }),
					Buffer.from(signature, "base64url"),
				),
			).toBe(true);
		}
	});

	it("refuses capabilities absent from the enrolled identity", async () => {
		const fixture = await writeConfig();
		const client = new AgentAuthClient(await loadAgentAuthConfig(fixture.path));
		await expect(client.execute("task.write", {})).rejects.toEqual(
			new AgentAuthClientError("AGENT_CAPABILITY_NOT_REQUESTED"),
		);
	});

	it("retries environment ticket issuance only when the server explicitly allows it", async () => {
		const fixture = await writeConfig();
		const config = await loadAgentAuthConfig(fixture.path);
		const wait = vi.fn(async () => undefined);
		let issueAttempts = 0;
		const request = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url === config.defaultLocation) {
					issueAttempts += 1;
					if (issueAttempts === 1) {
						return Response.json(
							{
								error: "AGENT_ENVIRONMENT_GATEWAY_UNAVAILABLE",
								message: "AGENT_ENVIRONMENT_GATEWAY_UNAVAILABLE",
								retryable: true,
								retry_after_ms: 750,
							},
							{ status: 503 },
						);
					}
					return Response.json({
						data: {
							protocolVersion: "paca.environment.connection.v1",
							requestId: "33333333-3333-4333-8333-333333333333",
							environmentId: "22222222-2222-4222-8222-222222222222",
							operationMode: "execute",
							transport: "websocket",
							url: "wss://paca-env.example.com/v1/connect",
							accessToken: "ticket-not-logged",
							expiresAt: "2026-09-02T08:00:45.000Z",
						},
					});
				}
				expect(url).toBe("https://paca-env.example.com/v1/connect");
				expect(new Headers(init?.headers).get("authorization")).toBe(
					"Bearer ticket-not-logged",
				);
				return Response.json({
					status: "ready",
					environmentId: "22222222-2222-4222-8222-222222222222",
				});
			},
		);
		const client = new AgentAuthClient(
			config,
			request as typeof fetch,
			() => new Date("2026-09-02T08:00:00.000Z"),
			wait,
		);

		await expect(
			client.execute("environment.connect", {
				requestId: "33333333-3333-4333-8333-333333333333",
			}),
		).resolves.toMatchObject({ transport: "websocket" });
		expect(issueAttempts).toBe(2);
		expect(wait).toHaveBeenCalledOnce();
		expect(wait).toHaveBeenCalledWith(750);
	});

	it("reacquires an idempotent environment ticket after a retryable prepare failure", async () => {
		const fixture = await writeConfig();
		const config = await loadAgentAuthConfig(fixture.path);
		const wait = vi.fn(async () => undefined);
		let prepareAttempts = 0;
		const request = vi.fn(async (input: string | URL | Request) => {
			if (String(input) === config.defaultLocation) {
				return Response.json({
					data: {
						protocolVersion: "paca.environment.connection.v1",
						requestId: "33333333-3333-4333-8333-333333333333",
						environmentId: "22222222-2222-4222-8222-222222222222",
						operationMode: "execute",
						transport: "websocket",
						url: "wss://paca-env.example.com/v1/connect",
						accessToken: `ticket-${prepareAttempts}`,
						expiresAt: "2026-09-02T08:00:45.000Z",
					},
				});
			}
			prepareAttempts += 1;
			return prepareAttempts === 1
				? Response.json(
						{
							code: "GATEWAY_PROVIDER_STARTING",
							retryable: true,
							retryAfterMs: 250,
							attempts: 3,
						},
						{ status: 503 },
					)
				: Response.json({
						status: "ready",
						environmentId: "22222222-2222-4222-8222-222222222222",
					});
		});
		const client = new AgentAuthClient(
			config,
			request as typeof fetch,
			() => new Date("2026-09-02T08:00:00.000Z"),
			wait,
		);

		await client.execute("environment.connect", {
			requestId: "33333333-3333-4333-8333-333333333333",
		});
		expect(prepareAttempts).toBe(2);
		expect(request).toHaveBeenCalledTimes(4);
		expect(wait).toHaveBeenCalledWith(250);
		const issueBodies = request.mock.calls
			.filter(([url]) => String(url) === config.defaultLocation)
			.map(([, init]) => JSON.parse(String(init?.body)) as unknown);
		expect(issueBodies[0]).toEqual(issueBodies[1]);
	});

	it("does not retry an unsupported environment provider", async () => {
		const fixture = await writeConfig();
		const request = vi.fn(async () =>
			Response.json(
				{
					error: "AGENT_ENVIRONMENT_PROVIDER_UNSUPPORTED",
					message: "AGENT_ENVIRONMENT_PROVIDER_UNSUPPORTED",
					retryable: false,
				},
				{ status: 503 },
			),
		);
		const wait = vi.fn(async () => undefined);
		const client = new AgentAuthClient(
			await loadAgentAuthConfig(fixture.path),
			request as typeof fetch,
			() => new Date("2026-09-02T08:00:00.000Z"),
			wait,
		);

		await expect(
			client.execute("environment.connect", {}),
		).rejects.toMatchObject({
			code: "AGENT_ENVIRONMENT_PROVIDER_UNSUPPORTED",
			retryable: false,
		});
		expect(request).toHaveBeenCalledOnce();
		expect(wait).not.toHaveBeenCalled();
	});

	it("rejects Agent API paths that could escape the enrolled origin boundary", async () => {
		const fixture = await writeConfig();
		const request = vi.fn();
		const client = new AgentAuthClient(
			await loadAgentAuthConfig(fixture.path),
			request as typeof fetch,
		);
		await expect(
			client.requestAgent(
				"//attacker.example/api/v1/agent/run",
				["project.read"],
				{
					method: "GET",
				},
			),
		).rejects.toMatchObject({ code: "AGENT_REQUEST_PATH_INVALID" });
		expect(request).not.toHaveBeenCalled();
	});

	it("reports local harness identity without changing business permissions", () => {
		expect(
			createAgentHeartbeatReport({
				kind: "codex",
				version: "1.2.3",
				instanceId: "local-1",
			}),
		).toEqual({
			harnesses: [{ kind: "codex", version: "1.2.3", instanceId: "local-1" }],
			labels: ["task:execute"],
		});
		expect(() => createAgentHeartbeatReport({ kind: "unknown" })).toThrow(
			"PACA_AGENT_HARNESS_INVALID",
		);
	});
});
