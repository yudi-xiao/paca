import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	AgentAuthClient,
	AgentAuthClientError,
	type AgentAuthConfig,
} from "../../agent-auth/client.js";
import { diagnoseLocalAgent } from "../../agent-auth/doctor.js";

const project = "11111111-1111-4111-8111-111111111111";
const now = Date.parse("2026-10-10T00:00:00Z");
function config(): AgentAuthConfig {
	const pair = generateKeyPairSync("ed25519");
	return {
		version: 1,
		providerOrigin: "https://paca.example.com",
		issuer: "https://paca.example.com/api/auth",
		defaultLocation: "https://paca.example.com/api/auth/capability/execute",
		agentId: "agent-1",
		agentName: "Codex",
		hostId: "host-1",
		keyAlgorithm: "Ed25519",
		publicKey: pair.publicKey.export({ format: "jwk" }),
		privateKey: pair.privateKey.export({ format: "jwk" }),
		capabilities: ["project.read"],
		grantRequests: [
			{
				capability: "project.read",
				constraints: {
					organizationId: "org-1",
					projectId: project,
					validUntil: "2099-01-01T00:00:00Z",
				},
			},
		],
		registeredAt: "2026-10-01T00:00:00Z",
	};
}
function response() {
	return {
		agent_id: "agent-1",
		host_id: "host-1",
		status: "active",
		agent_capability_grants: [
			{
				capability: "project.read",
				status: "active",
				constraints: {
					organizationId: "org-1",
					projectId: project,
					validUntil: "2099-01-01T00:00:00Z",
				},
			},
		],
	};
}
const environment = {
	PACA_AGENT_CONFIG: "/private/agent.json",
	PACA_PROJECT_ID: project,
};
function dependencies(value: unknown = response()) {
	return {
		load: vi.fn(async () => config()),
		status: vi.fn(async () => value),
		now: () => now,
	};
}

describe("local Agent diagnostics", () => {
	it("reads the authenticated status without executing a capability or heartbeat", async () => {
		const input = config();
		const request = vi.fn<typeof fetch>(async () => Response.json(response()));
		const client = new AgentAuthClient(input, request, () => new Date(now));
		await client.status();
		const [url, init] = request.mock.calls[0];
		expect(url).toBe(
			"https://paca.example.com/api/auth/agent/status?agent_id=agent-1",
		);
		expect(init?.method).toBe("GET");
		expect(init?.redirect).toBe("error");
		const headers = new Headers(init?.headers);
		const jwt = headers.get("authorization")?.slice(7) ?? "";
		const payload = JSON.parse(
			Buffer.from(jwt.split(".")[1], "base64url").toString(),
		);
		expect(payload).toMatchObject({
			sub: "agent-1",
			iss: "host-1",
			aud: input.defaultLocation,
		});
		expect(payload.exp - payload.iat).toBe(45);
		expect(request).toHaveBeenCalledTimes(1);
	});
	it("returns a bounded summary without serializing response payloads, keys or grants", async () => {
		const input = config();
		const raw = {
			...response(),
			secret: "remote secret",
			prompt: "private task",
			privateKey: input.privateKey,
		};
		const report = await diagnoseLocalAgent(environment, {
			...dependencies(raw),
			load: async () => input,
		});
		expect(report).toMatchObject({
			status: "connected",
			code: "PACA_AGENT_CONNECTED",
			configuredTools: ["get_project"],
			grants: { active: 1, pending: 0, inactive: 0 },
		});
		for (const secret of [
			input.privateKey.d,
			"remote secret",
			"private task",
			"validUntil",
			"organizationId",
		])
			expect(JSON.stringify(report)).not.toContain(secret);
	});
	it.each([
		"PACA_API_KEY",
		"PACA_CAPABILITY_BROKER_TOKEN",
		"PACA_CAPABILITY_BROKER_URL",
		"PACA_CAPABILITY_BROKER_CONFIG",
	])("rejects ambiguous credentials before reading files: %s", async (key) => {
		const deps = dependencies();
		expect(
			await diagnoseLocalAgent({ ...environment, [key]: "credential" }, deps),
		).toMatchObject({ status: "error", code: "PACA_AUTH_MODE_AMBIGUOUS" });
		expect(deps.load).not.toHaveBeenCalled();
		expect(deps.status).not.toHaveBeenCalled();
	});
	it("reports missing configuration", async () => {
		const deps = dependencies();
		expect(await diagnoseLocalAgent({}, deps)).toMatchObject({
			code: "PACA_AGENT_CONFIG_REQUIRED",
		});
		expect(deps.status).not.toHaveBeenCalled();
	});
	it.each([
		"PACA_AGENT_CONFIG_PERMISSIONS_INVALID",
		"PACA_AGENT_CONFIG_INVALID",
		"AGENT_NETWORK_UNAVAILABLE",
	])("gives actionable guidance for %s", async (code) => {
		const report = await diagnoseLocalAgent(environment, {
			...dependencies(),
			load: async () => {
				throw new AgentAuthClientError(code);
			},
		});
		expect(report).toMatchObject({ status: "error", code });
		expect(report.message.length).toBeGreaterThan(30);
	});
	it.each([
		{ PACA_AGENT_ID: "other-agent" },
		{ PACA_PROJECT_ID: "22222222-2222-4222-8222-222222222222" },
		{ PACA_PROJECT_ID: "invalid" },
	])("rejects another identity/project before network I/O", async (override) => {
		const deps = dependencies();
		expect(
			(await diagnoseLocalAgent({ ...environment, ...override }, deps)).status,
		).toBe("error");
		expect(deps.status).not.toHaveBeenCalled();
	});
	it.each([
		"pending",
		"revoked",
		"expired",
		"rejected",
	])("does not report an inactive Agent as connected: %s", async (status) => {
		expect(
			await diagnoseLocalAgent(
				environment,
				dependencies({ ...response(), status }),
			),
		).toMatchObject({
			status: "needs_attention",
			code: status === "pending" ? "PACA_AGENT_PENDING" : "PACA_AGENT_INACTIVE",
		});
	});
	it.each([
		"pending",
		"revoked",
		"expired",
		"denied",
		"consumed",
	])("does not advertise tools from %s grants", async (status) => {
		const value = response();
		value.agent_capability_grants[0].status = status;
		expect(
			await diagnoseLocalAgent(environment, dependencies(value)),
		).toMatchObject({ status: "needs_attention", configuredTools: [] });
	});
	it("filters grants belonging to a different project", async () => {
		const value = response();
		value.agent_capability_grants[0].constraints.projectId =
			"22222222-2222-4222-8222-222222222222";
		expect(
			await diagnoseLocalAgent(environment, dependencies(value)),
		).toMatchObject({
			code: "PACA_AGENT_GRANTS_UNAVAILABLE",
			configuredTools: [],
		});
	});
	it.each([
		"2026-10-09T00:00:00Z",
		"invalid",
	])("rejects expired/malformed constraint dates: %s", async (date) => {
		const value = response();
		value.agent_capability_grants[0].constraints.validUntil = date;
		expect(
			await diagnoseLocalAgent(environment, dependencies(value)),
		).toMatchObject({
			code: "PACA_AGENT_GRANTS_UNAVAILABLE",
			configuredTools: [],
		});
	});
	it.each([
		null,
		{ ...response(), host_id: "other-host" },
		{ ...response(), agent_id: "other-agent" },
		{ ...response(), status: "unexpected" },
		{
			...response(),
			agent_capability_grants: Array(129).fill(
				response().agent_capability_grants[0],
			),
		},
	])("rejects malformed or mismatched status responses", async (value) => {
		expect(
			await diagnoseLocalAgent(environment, dependencies(value)),
		).toMatchObject({ code: "AGENT_RESPONSE_INVALID", status: "error" });
	});
	it("cancels an oversized streamed status response before reading the remainder", async () => {
		const cancel = vi.fn();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(1024 * 1024 + 1));
			},
			cancel,
		});
		const client = new AgentAuthClient(
			config(),
			async () => new Response(stream),
		);
		await expect(client.status()).rejects.toMatchObject({
			code: "AGENT_RESPONSE_INVALID",
		});
		expect(cancel).toHaveBeenCalledOnce();
	});
	it("does not advertise tools when the Agent itself has expired", async () => {
		const report = await diagnoseLocalAgent(
			environment,
			dependencies({ ...response(), expires_at: "2026-10-09T00:00:00Z" }),
		);
		expect(report).toMatchObject({
			status: "needs_attention",
			configuredTools: [],
			code: "PACA_AGENT_INACTIVE",
		});
	});
	it("does not print arbitrary error messages", async () => {
		const report = await diagnoseLocalAgent(environment, {
			...dependencies(),
			status: async () => {
				throw Error("Bearer secret");
			},
		});
		expect(report.code).toBe("PACA_AGENT_DIAGNOSTIC_FAILED");
		expect(JSON.stringify(report)).not.toContain("Bearer secret");
	});
});
