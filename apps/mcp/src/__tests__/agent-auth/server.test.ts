import { describe, expect, it, vi } from "vitest";
import type {
	AgentAuthConfig,
	AgentHeartbeatReport,
} from "../../agent-auth/client.js";
import {
	callAgentCapabilityTool,
	getAgentCapabilityTools,
	type AgentCapabilityTransport,
} from "../../agent-auth/server.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";

function config(): AgentAuthConfig {
	return {
		version: 1,
		providerOrigin: "https://paca.example.com",
		issuer: "https://paca.example.com/api/auth",
		defaultLocation: "https://paca.example.com/api/auth/capability/execute",
		hostId: "host-1",
		agentId: "agent-1",
		agentName: "Codex",
		keyAlgorithm: "Ed25519",
		publicKey: { kty: "OKP", crv: "Ed25519", x: "public" },
		privateKey: { kty: "OKP", crv: "Ed25519", x: "public", d: "private" },
		capabilities: [
			"project.read",
			"task.read",
			"task.write",
			"task.execute",
			"task.create",
		],
		grantRequests: [
			{
				capability: "project.read",
				constraints: {
					organizationId: "org-1",
					projectId: PROJECT_ID,
					validUntil: "2099-01-01T00:00:00.000Z",
				},
			},
			{
				capability: "task.write",
				constraints: {
					organizationId: "org-1",
					projectId: PROJECT_ID,
					taskId: TASK_ID,
					field: "title",
					operationMode: "collaborate",
					validUntil: "2099-01-01T00:00:00.000Z",
				},
			},
			{
				capability: "task.execute",
				constraints: {
					organizationId: "org-1",
					projectId: PROJECT_ID,
					validUntil: "2099-01-01T00:00:00.000Z",
				},
			},
		],
		registeredAt: "2026-09-01T00:00:00.000Z",
	};
}

const heartbeat: AgentHeartbeatReport = {
	harnesses: [{ kind: "codex", instanceId: "local-1" }],
	labels: ["task:execute"],
};

function transport(): AgentCapabilityTransport & {
	execute: ReturnType<typeof vi.fn>;
	discoverTasks: ReturnType<typeof vi.fn>;
	heartbeat: ReturnType<typeof vi.fn>;
} {
	return {
		config: config(),
		execute: vi.fn(async () => ({ ok: true })),
		discoverTasks: vi.fn(async () => [{ task_id: TASK_ID }]),
		heartbeat: vi.fn(async () => ({ online: true })),
	};
}

describe("Agent Auth MCP tools", () => {
	it("exposes only capabilities that also have requested Grant scope", () => {
		expect(getAgentCapabilityTools(config()).map((tool) => tool.name)).toEqual([
			"get_project",
			"update_task",
			"discover_tasks",
		]);
	});

	it("executes a project read with server-verifiable exact constraints", async () => {
		const client = transport();
		await callAgentCapabilityTool(
			client,
			"get_project",
			{ projectId: PROJECT_ID },
			PROJECT_ID,
		);
		expect(client.execute).toHaveBeenCalledWith("project.read", {
			organizationId: "org-1",
			projectId: PROJECT_ID,
			validUntil: "2099-01-01T00:00:00.000Z",
		});
	});

	it("fails closed before the network when task or field scope differs", async () => {
		const client = transport();
		await expect(
			callAgentCapabilityTool(client, "update_task", {
				projectId: PROJECT_ID,
				taskId: TASK_ID,
				field: "description",
				value: "not authorized",
			}),
		).rejects.toThrow("AGENT_CAPABILITY_SCOPE_NOT_REQUESTED");
		expect(client.execute).not.toHaveBeenCalled();
	});

	it("pins all tools to the configured project", async () => {
		const client = transport();
		await expect(
			callAgentCapabilityTool(
				client,
				"get_project",
				{
					projectId: "33333333-3333-4333-8333-333333333333",
				},
				PROJECT_ID,
			),
		).rejects.toThrow("AGENT_PROJECT_PIN_MISMATCH");
		expect(client.execute).not.toHaveBeenCalled();
	});

	it("refreshes Host presence before discovering executable tasks", async () => {
		const client = transport();
		await callAgentCapabilityTool(
			client,
			"discover_tasks",
			{},
			undefined,
			heartbeat,
		);
		expect(client.heartbeat).toHaveBeenCalledWith(heartbeat);
		expect(client.heartbeat.mock.invocationCallOrder[0]).toBeLessThan(
			client.discoverTasks.mock.invocationCallOrder[0],
		);
	});
});
