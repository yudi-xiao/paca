import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function check(value, code) {
	if (!value) throw Error(code);
}
const projectId = process.env.PACA_PROJECT_ID;
const taskId = process.env.PACA_SMOKE_TASK_ID;
const documentId = process.env.PACA_SMOKE_DOCUMENT_ID;
const query = process.env.PACA_SMOKE_SEARCH_QUERY;
check(
	process.env.PACA_LOCAL_AGENT_SMOKE_CONFIRM ===
		"RUN_INTERNAL_LOCAL_AGENT_SMOKE",
	"SMOKE_CONFIRM_REQUIRED",
);
for (const id of [projectId, taskId, documentId])
	check(
		typeof id === "string" && /^[a-f0-9-]{36}$/.test(id),
		"SMOKE_SCOPE_REQUIRED",
	);
check(
	typeof query === "string" && query.length > 0 && query.length <= 200,
	"SMOKE_QUERY_REQUIRED",
);
check(process.env.PACA_AGENT_CONFIG, "SMOKE_AGENT_CONFIG_REQUIRED");
const userCookie = process.env.PACA_SMOKE_USER_COOKIE;
check(
	typeof userCookie === "string" && userCookie.length > 0,
	"SMOKE_USER_SESSION_REQUIRED",
);
const environment = Object.fromEntries(
	Object.entries(process.env).filter(
		(entry) =>
			typeof entry[1] === "string" && entry[0] !== "PACA_SMOKE_USER_COOKIE",
	),
);
const transportOptions = {
	command: process.execPath,
	args: [fileURLToPath(new URL("../build/index.js", import.meta.url))],
	env: {
		...environment,
		PACA_AGENT_HARNESS_KIND: "codex",
		PACA_AGENT_HARNESS_VERSION: "internal-smoke",
		PACA_AGENT_HARNESS_INSTANCE_ID: `local-smoke-${randomUUID()}`,
	},
	stderr: "pipe",
};
let transport = new StdioClientTransport(transportOptions);
let client = new Client({ name: "Paca local Agent smoke", version: "1.0.0" });
async function tool(name, arguments_) {
	const result = await client.callTool(
		{ name, arguments: arguments_ },
		undefined,
		{ timeout: 25000 },
	);
	const content = result.content?.find((item) => item.type === "text");
	if (result.isError) {
		const code = content?.text.replace(/^Error:\s*/, "");
		const safeCode =
			typeof code === "string" && /^[A-Z][A-Z0-9_]{0,100}$/.test(code)
				? code
				: "TOOL_FAILED";
		throw Error(
			`${name.toUpperCase()}_${typeof arguments_.action === "string" ? `${arguments_.action.toUpperCase()}_` : ""}${safeCode}`,
		);
	}
	check(content && content.text.length <= 100000, "SMOKE_MCP_RESPONSE_INVALID");
	const value = JSON.parse(content.text);
	return value.data ?? value;
}
async function userPost(path, body) {
	const response = await fetch(`https://paca.howlearnwood.com${path}`, {
		method: "POST",
		headers: {
			origin: "https://paca.howlearnwood.com",
			cookie: userCookie,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
		redirect: "error",
		signal: AbortSignal.timeout(20000),
	});
	check(response.status === 200, "SMOKE_USER_CONTROL_FAILED");
}
async function denied(operation) {
	const result = await client.callTool(
		{ name: "execute_task_lease", arguments: operation },
		undefined,
		{ timeout: 25000 },
	);
	check(result.isError === true, "SMOKE_TERMINATED_LEASE_ALLOWED");
}
try {
	await client.connect(transport);
	const advertised = new Set(
		(await client.listTools()).tools.map((item) => item.name),
	);
	for (const name of [
		"search_tasks",
		"search_docs",
		"discover_tasks",
		"execute_task_lease",
	])
		check(advertised.has(name), "SMOKE_MCP_TOOLS_MISSING");
	const tasks = await tool("search_tasks", { projectId, query });
	check(
		tasks.items?.length === 1 && tasks.items[0].id === taskId,
		"SMOKE_TASK_SCOPE_LEAK",
	);
	const docs = await tool("search_docs", { projectId, query });
	check(
		docs.items?.length === 1 && docs.items[0].id === documentId,
		"SMOKE_DOCUMENT_SCOPE_LEAK",
	);
	const found = await tool("discover_tasks", {});
	check(
		Array.isArray(found) && found.length === 1 && found[0].task_id === taskId,
		"SMOKE_DISCOVERY_SCOPE_LEAK",
	);
	const base = { projectId, taskId };
	const claim = {
		...base,
		action: "claim",
		requestId: randomUUID(),
		leaseDurationMs: 60000,
	};
	const claimed = await tool("execute_task_lease", claim);
	check(
		!claimed.duplicate && claimed.lease?.status === "active",
		"SMOKE_CLAIM_INVALID",
	);
	const duplicate = await tool("execute_task_lease", claim);
	check(
		duplicate.duplicate && duplicate.lease?.id === claimed.lease.id,
		"SMOKE_CLAIM_NOT_IDEMPOTENT",
	);
	const owned = { ...base, leaseId: claimed.lease.id };
	const renewed = await tool("execute_task_lease", {
		...owned,
		action: "renew",
		requestId: randomUUID(),
		leaseDurationMs: 60000,
	});
	check(renewed.lease?.status === "active", "SMOKE_RENEW_INVALID");
	const checkpoint = await tool("execute_task_lease", {
		...owned,
		action: "checkpoint",
		requestId: randomUUID(),
		sequence: 1,
		checkpointKey: "smoke/checkpoint-1",
		summary: "Protocol smoke checkpoint",
	});
	check(
		checkpoint.lease?.lastCheckpointSequence === 1,
		"SMOKE_CHECKPOINT_INVALID",
	);
	await client.close();
	await transport.close();
	transport = new StdioClientTransport(transportOptions);
	client = new Client({
		name: "Paca local Agent recovery smoke",
		version: "1.0.0",
	});
	await client.connect(transport);
	const recovered = await tool("discover_tasks", {});
	check(
		Array.isArray(recovered) &&
			recovered.length === 1 &&
			recovered[0].availability === "owned" &&
			recovered[0].lease?.id === claimed.lease.id &&
			recovered[0].lease?.last_checkpoint_sequence === 1,
		"SMOKE_LEASE_RECOVERY_INVALID",
	);
	const completed = await tool("execute_task_lease", {
		...owned,
		action: "complete",
		requestId: randomUUID(),
		summary: "Protocol smoke complete; delivery acceptance remains separate.",
	});
	check(completed.lease?.status === "completed", "SMOKE_COMPLETE_INVALID");
	const cancelling = await tool("execute_task_lease", {
		...claim,
		requestId: randomUUID(),
	});
	check(cancelling.lease?.status === "active", "SMOKE_SECOND_CLAIM_INVALID");
	await userPost(
		`/api/v1/projects/${projectId}/tasks/${taskId}/agent-lease/cancel`,
		{
			request_id: randomUUID(),
			reason: "Temporary cancellation smoke",
		},
	);
	await denied({
		...base,
		leaseId: cancelling.lease.id,
		action: "renew",
		requestId: randomUUID(),
		leaseDurationMs: 60000,
	});
	const cancelled = await tool("execute_task_lease", {
		...base,
		leaseId: cancelling.lease.id,
		action: "cancel_ack",
		requestId: randomUUID(),
	});
	check(cancelled.lease?.status === "cancelled", "SMOKE_CANCEL_ACK_INVALID");
	const revoking = await tool("execute_task_lease", {
		...claim,
		requestId: randomUUID(),
	});
	check(revoking.lease?.status === "active", "SMOKE_THIRD_CLAIM_INVALID");
	const config = JSON.parse(
		await (await import("node:fs/promises")).readFile(
			process.env.PACA_AGENT_CONFIG,
			"utf8",
		),
	);
	await userPost("/api/auth/paca-agent/revoke-capability", {
		agent_id: config.agentId,
		capabilities: ["task.execute"],
	});
	await denied({
		...base,
		leaseId: revoking.lease.id,
		action: "renew",
		requestId: randomUUID(),
		leaseDurationMs: 60000,
	});
	console.log(
		JSON.stringify({
			status: "ok",
			step: "local-agent-stdio-search-and-task-lease",
		}),
	);
} catch (error) {
	console.error(
		JSON.stringify({
			status: "error",
			step: "local-agent-stdio-smoke",
			code:
				error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
					? error.message
					: "SMOKE_FAILED",
		}),
	);
	process.exitCode = 1;
} finally {
	await client.close().catch(() => {
		process.exitCode = 1;
	});
	await transport.close().catch(() => {
		process.exitCode = 1;
	});
}
