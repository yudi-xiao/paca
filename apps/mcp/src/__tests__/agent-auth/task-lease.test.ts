import { describe, expect, it, vi } from "vitest";
import type {
	AgentCapabilityConfig,
	AgentHeartbeatReport,
} from "../../agent-auth/client.js";
import {
	type AgentCapabilityTransport,
	callAgentCapabilityTool,
	getAgentCapabilityTools,
} from "../../agent-auth/server.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const leaseId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
const validUntil = "2099-01-01T00:00:00Z";
const heartbeat: AgentHeartbeatReport = {
	harnesses: [{ kind: "codex", version: "test", instanceId: "local-instance" }],
	labels: ["task:execute"],
};
function client(): AgentCapabilityTransport {
	const config: AgentCapabilityConfig = {
		version: 1,
		agentId: "agent-1",
		capabilities: ["task.execute"],
		grantRequests: [
			{
				capability: "task.execute",
				constraints: {
					organizationId: "org-1",
					projectId: { eq: projectId },
					taskId: { eq: taskId },
					operationMode: "execute",
					validUntil,
					action: {
						in: [
							"claim",
							"renew",
							"checkpoint",
							"complete",
							"fail",
							"cancel_ack",
						],
					},
				},
			},
		],
	};
	return {
		config,
		execute: vi.fn(async () => ({
			duplicate: false,
			lease: { id: leaseId, status: "active" },
		})),
		heartbeat: vi.fn(async () => ({})),
		discoverTasks: vi.fn(),
		requestAgent: vi.fn(),
	};
}
const claim = {
	projectId,
	taskId,
	requestId,
	action: "claim",
	leaseDurationMs: 60000,
};
describe("local MCP task lease control", () => {
	it("advertises control only for explicitly scoped execute grants", () => {
		const value = client();
		expect(
			getAgentCapabilityTools(value.config).map((tool) => tool.name),
		).toEqual(["discover_tasks", "execute_task_lease"]);
		delete value.config.grantRequests[0]?.constraints.taskId;
		expect(
			getAgentCapabilityTools(value.config).map((tool) => tool.name),
		).toEqual(["discover_tasks"]);
	});
	it("derives org, expiry and harness from trusted configuration and preserves the caller's idempotency key", async () => {
		const value = client();
		await callAgentCapabilityTool(
			value,
			"execute_task_lease",
			claim,
			projectId,
			heartbeat,
		);
		expect(value.heartbeat).toHaveBeenCalledWith(heartbeat);
		expect(value.execute).toHaveBeenCalledWith("task.execute", {
			...claim,
			organizationId: "org-1",
			operationMode: "execute",
			validUntil,
			harness: heartbeat.harnesses[0],
		});
		expect(value.requestAgent).not.toHaveBeenCalled();
	});
	it.each([
		{ action: "renew", leaseDurationMs: 5000 },
		{
			action: "checkpoint",
			sequence: 1,
			summary: "Resumable step",
			checkpointKey: "runs/step-1",
			artifactKeys: ["reports/check.txt"],
		},
		{ action: "complete", summary: "Execution complete; acceptance pending" },
		{ action: "fail", errorCode: "LOCAL_TOOL_DENIED" },
		{ action: "cancel_ack", summary: "Local execution stopped" },
	])("passes $action through the server coordinator without a claim harness", async (operation) => {
		const value = client();
		const input = { projectId, taskId, leaseId, requestId, ...operation };
		await callAgentCapabilityTool(
			value,
			"execute_task_lease",
			input,
			projectId,
			heartbeat,
		);
		expect(value.execute).toHaveBeenCalledWith("task.execute", {
			...input,
			organizationId: "org-1",
			operationMode: "execute",
			validUntil,
		});
	});
	it.each([
		{ actorId: "someone-else" },
		{ hostId: "another-host" },
		{ harness: { kind: "claude-code" } },
		{ validUntil: "2100-01-01T00:00:00Z" },
		{ operationMode: "collaborate" },
		{ action: "shell" },
		{ leaseDurationMs: 300001 },
		{ leaseDurationMs: 4999 },
		{ requestId: "not-a-uuid" },
		{ taskId: projectId },
		{ projectId: taskId },
	])("rejects scope escape, credential forwarding and invalid command fields: %j", async (fields) => {
		const value = client();
		await expect(
			callAgentCapabilityTool(
				value,
				"execute_task_lease",
				{ ...claim, ...fields },
				projectId,
				heartbeat,
			),
		).rejects.toThrow();
		expect(value.execute).not.toHaveBeenCalled();
		expect(value.heartbeat).not.toHaveBeenCalled();
	});
	it.each([
		"expired",
		"invalid-time",
		"missing-action",
		"wrong-mode",
		"write-only",
		"no-harness",
	])("fails closed before presence or execution for %s", async (kind) => {
		const value = client();
		const constraints = value.config.grantRequests[0]?.constraints;
		if (!constraints) throw Error();
		if (kind === "expired") constraints.validUntil = "2000-01-01T00:00:00Z";
		if (kind === "invalid-time") constraints.validUntil = "invalid";
		if (kind === "missing-action") delete constraints.action;
		if (kind === "wrong-mode") constraints.operationMode = "read";
		if (kind === "write-only") value.config.capabilities = ["task.write"];
		await expect(
			callAgentCapabilityTool(
				value,
				"execute_task_lease",
				claim,
				projectId,
				kind === "no-harness" ? undefined : heartbeat,
			),
		).rejects.toThrow();
		expect(value.execute).not.toHaveBeenCalled();
		expect(value.heartbeat).not.toHaveBeenCalled();
	});
	it.each([
		"../secret",
		"/absolute",
		"safe/../escape",
	])("rejects unsafe artifact keys %s", async (key) => {
		const value = client();
		await expect(
			callAgentCapabilityTool(
				value,
				"execute_task_lease",
				{
					projectId,
					taskId,
					requestId,
					leaseId,
					action: "checkpoint",
					sequence: 1,
					artifactKeys: [key],
				},
				projectId,
				heartbeat,
			),
		).rejects.toThrow();
		expect(value.execute).not.toHaveBeenCalled();
	});
	it("keeps lease failures terminal for this call and does not replay operations", async () => {
		const value = client();
		value.execute = vi.fn(async () => {
			throw Error("AGENT_TASK_LEASE_REVOKED");
		});
		await expect(
			callAgentCapabilityTool(
				value,
				"execute_task_lease",
				claim,
				projectId,
				heartbeat,
			),
		).rejects.toThrow("AGENT_TASK_LEASE_REVOKED");
		expect(value.execute).toHaveBeenCalledTimes(1);
	});
});
