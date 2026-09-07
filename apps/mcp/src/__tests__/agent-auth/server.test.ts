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
			"document.read",
			"document.edit",
			"workflow.execute",
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
			{
				capability: "document.read",
				constraints: {
					organizationId: "org-1",
					projectId: { eq: PROJECT_ID },
					documentId: "44444444-4444-4444-8444-444444444444",
					validUntil: "2099-01-01T00:00:00.000Z",
				},
			},
			{
				capability: "document.edit",
				constraints: {
					organizationId: "org-1",
					projectId: PROJECT_ID,
					documentId: "44444444-4444-4444-8444-444444444444",
					field: "block.content",
					action: { in: ["apply"] },
					operationMode: { in: ["suggest", "collaborate"] },
					validUntil: "2099-01-01T00:00:00.000Z",
				},
			},
			{
				capability: "workflow.execute",
				constraints: {
					organizationId: "org-1",
					projectId: PROJECT_ID,
					workflowId: "00000000-0000-4000-8000-000000000201",
					operationMode: "execute",
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
	requestAgent: ReturnType<typeof vi.fn>;
} {
	return {
		config: config(),
		execute: vi.fn(async () => ({ ok: true })),
		discoverTasks: vi.fn(async () => [{ task_id: TASK_ID }]),
		heartbeat: vi.fn(async () => ({ online: true })),
		requestAgent: vi.fn(async () => ({ status: "queued" })),
	};
}

describe("Agent Auth MCP tools", () => {
	it("exposes only capabilities that also have requested Grant scope", () => {
		expect(getAgentCapabilityTools(config()).map((tool) => tool.name)).toEqual([
			"get_project",
			"update_task",
			"discover_tasks",
			"get_document",
			"edit_document",
			"start_document_workflow",
			"get_agent_run",
			"cancel_agent_run",
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

	it("reads a document through exact or eq Grant constraints", async () => {
		const client = transport();
		const documentId = "44444444-4444-4444-8444-444444444444";
		await callAgentCapabilityTool(client, "get_document", {
			projectId: PROJECT_ID,
			documentId,
		});
		expect(client.execute).toHaveBeenCalledWith("document.read", {
			organizationId: "org-1",
			projectId: PROJECT_ID,
			documentId,
			validUntil: "2099-01-01T00:00:00.000Z",
		});
	});

	it("submits only version-checked block edits allowed by in constraints", async () => {
		const client = transport();
		const documentId = "44444444-4444-4444-8444-444444444444";
		const requestId = "55555555-5555-4555-8555-555555555555";
		const runId = "66666666-6666-4666-8666-666666666666";
		await callAgentCapabilityTool(client, "edit_document", {
			projectId: PROJECT_ID,
			documentId,
			requestId,
			runId,
			baseRevision: 7,
			baseStateVector: "state-vector",
			operationMode: "collaborate",
			operations: [
				{
					type: "replace_block_content",
					blockId: "block-1",
					expectedBlockVersion: "block-version",
					content: [{ type: "text", text: "Agent edit" }],
				},
			],
		});
		expect(client.execute).toHaveBeenCalledWith("document.edit", {
			organizationId: "org-1",
			projectId: PROJECT_ID,
			validUntil: "2099-01-01T00:00:00.000Z",
			documentId,
			field: "block.content",
			action: "apply",
			requestId,
			runId,
			baseRevision: 7,
			baseStateVector: "state-vector",
			operationMode: "collaborate",
			operations: [
				{
					type: "replace_block_content",
					blockId: "block-1",
					expectedBlockVersion: "block-version",
					content: [{ type: "text", text: "Agent edit", styles: {} }],
				},
			],
		});
	});

	it("starts a durable document workflow with both required capabilities", async () => {
		const client = transport();
		const documentId = "44444444-4444-4444-8444-444444444444";
		const requestId = "55555555-5555-4555-8555-555555555555";
		const runId = "66666666-6666-4666-8666-666666666666";
		await callAgentCapabilityTool(client, "start_document_workflow", {
			projectId: PROJECT_ID,
			documentId,
			requestId,
			runId,
			baseRevision: 7,
			baseStateVector: "state-vector",
			operationMode: "suggest",
			operations: [
				{
					type: "replace_block_content",
					blockId: "block-1",
					expectedBlockVersion: "block-version",
					content: [{ type: "text", text: "Suggestion" }],
				},
			],
		});

		expect(client.requestAgent).toHaveBeenCalledOnce();
		const [path, capabilities, init] = client.requestAgent.mock.calls[0];
		expect(path).toBe(
			`/api/v1/agent/projects/${PROJECT_ID}/workflows/00000000-0000-4000-8000-000000000201/runs`,
		);
		expect(capabilities).toEqual(["workflow.execute", "document.edit"]);
		expect(init).toMatchObject({ method: "POST" });
		expect(JSON.parse(init.body as string)).toMatchObject({
			organizationId: "org-1",
			documentId,
			command: {
				action: "apply",
				requestId,
				runId,
				operationMode: "suggest",
			},
		});
	});

	it("reads and cancels only runs owned through the scoped workflow Grant", async () => {
		const client = transport();
		const runId = "66666666-6666-4666-8666-666666666666";
		await callAgentCapabilityTool(client, "get_agent_run", {
			projectId: PROJECT_ID,
			runId,
		});
		await callAgentCapabilityTool(client, "cancel_agent_run", {
			projectId: PROJECT_ID,
			runId,
		});
		expect(client.requestAgent).toHaveBeenNthCalledWith(
			1,
			`/api/v1/agent/projects/${PROJECT_ID}/workflows/00000000-0000-4000-8000-000000000201/runs/${runId}`,
			["workflow.execute"],
			{ method: "GET" },
		);
		expect(client.requestAgent).toHaveBeenNthCalledWith(
			2,
			`/api/v1/agent/projects/${PROJECT_ID}/workflows/00000000-0000-4000-8000-000000000201/runs/${runId}`,
			["workflow.execute"],
			{ method: "DELETE" },
		);
	});
});
