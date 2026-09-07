import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { markdownToBlocknote } from "../utils/index.js";
import {
	type AgentAuthConfig,
	type AgentGrantRequest,
	type AgentHeartbeatReport,
	exactConstraint,
} from "./client.js";

type JsonRecord = Record<string, unknown>;

const scopeInput = z.object({ projectId: z.string().uuid() }).strict();
const taskInput = scopeInput.extend({ taskId: z.string().uuid() }).strict();
const createTaskInput = scopeInput
	.extend({
		title: z.string().min(1).max(500),
		description: z.string().optional(),
		importance: z.number().int().min(0).max(1_000_000).optional(),
		storyPoints: z.number().int().min(0).max(1_000_000).nullable().optional(),
		tags: z.array(z.string().max(100)).max(50).optional(),
	})
	.strict();
const updateTaskInput = taskInput
	.extend({
		field: z.enum([
			"title",
			"description",
			"statusId",
			"sprintId",
			"taskTypeId",
			"importance",
			"storyPoints",
			"startDate",
			"dueDate",
			"tags",
		]),
		value: z.unknown(),
	})
	.strict();

function matchingGrant(
	config: AgentAuthConfig,
	capability: string,
	predicate: (constraints: JsonRecord) => boolean,
): AgentGrantRequest {
	const grant = config.grantRequests.find(
		(request) =>
			request.capability === capability && predicate(request.constraints),
	);
	if (!grant) throw new Error("AGENT_CAPABILITY_SCOPE_NOT_REQUESTED");
	return grant;
}

function scopedGrant(
	config: AgentAuthConfig,
	capability: string,
	projectId: string,
	taskId?: string,
	field?: string,
): AgentGrantRequest {
	return matchingGrant(config, capability, (constraints) => {
		if (exactConstraint(constraints.projectId) !== projectId) return false;
		if (taskId !== undefined && exactConstraint(constraints.taskId) !== taskId)
			return false;
		return field === undefined || exactConstraint(constraints.field) === field;
	});
}

function executionScope(grant: AgentGrantRequest): JsonRecord {
	const organizationId = exactConstraint(grant.constraints.organizationId);
	const projectId = exactConstraint(grant.constraints.projectId);
	const validUntil = exactConstraint(grant.constraints.validUntil);
	if (
		!organizationId ||
		!projectId ||
		!validUntil ||
		Date.parse(validUntil) <= Date.now()
	) {
		throw new Error("AGENT_CAPABILITY_SCOPE_INVALID");
	}
	return { organizationId, projectId, validUntil };
}

export interface AgentCapabilityTransport {
	readonly config: AgentAuthConfig;
	execute(capability: string, arguments_: JsonRecord): Promise<unknown>;
	discoverTasks(): Promise<unknown>;
	heartbeat(report: AgentHeartbeatReport): Promise<unknown>;
}

function result(value: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
	};
}

const tools: Record<string, Tool> = {
	get_project: {
		name: "get_project",
		description:
			"Read one project explicitly authorized by the Agent's project.read Grant.",
		inputSchema: {
			type: "object",
			properties: { projectId: { type: "string", format: "uuid" } },
			required: ["projectId"],
			additionalProperties: false,
		},
	},
	get_task: {
		name: "get_task",
		description:
			"Read one task explicitly authorized by the Agent's task.read Grant.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string", format: "uuid" },
				taskId: { type: "string", format: "uuid" },
			},
			required: ["projectId", "taskId"],
			additionalProperties: false,
		},
	},
	create_task: {
		name: "create_task",
		description:
			"Create or suggest a task within an explicitly authorized task.create scope.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string", format: "uuid" },
				title: { type: "string", minLength: 1, maxLength: 500 },
				description: { type: "string" },
				importance: { type: "integer", minimum: 0, maximum: 1_000_000 },
				storyPoints: {
					type: ["integer", "null"],
					minimum: 0,
					maximum: 1_000_000,
				},
				tags: {
					type: "array",
					maxItems: 50,
					items: { type: "string", maxLength: 100 },
				},
			},
			required: ["projectId", "title"],
			additionalProperties: false,
		},
	},
	update_task: {
		name: "update_task",
		description:
			"Update or suggest exactly one field on one task. The field must match the Agent's task.write Grant.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string", format: "uuid" },
				taskId: { type: "string", format: "uuid" },
				field: {
					type: "string",
					enum: [
						"title",
						"description",
						"statusId",
						"sprintId",
						"taskTypeId",
						"importance",
						"storyPoints",
						"startDate",
						"dueDate",
						"tags",
					],
				},
				value: {},
			},
			required: ["projectId", "taskId", "field", "value"],
			additionalProperties: false,
		},
	},
	discover_tasks: {
		name: "discover_tasks",
		description:
			"List task.execute work derived by the server from active Grants, delegated permissions and Host labels.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	},
};

export function getAgentCapabilityTools(config: AgentAuthConfig): Tool[] {
	const requested = new Set(
		config.grantRequests.map((request) => request.capability),
	);
	const available = (capability: string) =>
		config.capabilities.includes(capability) && requested.has(capability);
	return [
		...(available("project.read") ? [tools.get_project] : []),
		...(available("task.read") ? [tools.get_task] : []),
		...(available("task.create") ? [tools.create_task] : []),
		...(available("task.write") ? [tools.update_task] : []),
		...(available("task.execute") ? [tools.discover_tasks] : []),
	];
}

export async function callAgentCapabilityTool(
	client: AgentCapabilityTransport,
	name: string,
	value: unknown,
	projectPin?: string,
	heartbeat?: AgentHeartbeatReport,
): Promise<ReturnType<typeof result>> {
	const requirePin = (projectId: string) => {
		if (projectPin && projectId !== projectPin)
			throw new Error("AGENT_PROJECT_PIN_MISMATCH");
	};
	switch (name) {
		case "get_project": {
			const input = scopeInput.parse(value);
			requirePin(input.projectId);
			const grant = scopedGrant(client.config, "project.read", input.projectId);
			return result(
				await client.execute("project.read", executionScope(grant)),
			);
		}
		case "get_task": {
			const input = taskInput.parse(value);
			requirePin(input.projectId);
			const grant = scopedGrant(
				client.config,
				"task.read",
				input.projectId,
				input.taskId,
			);
			return result(
				await client.execute("task.read", {
					...executionScope(grant),
					taskId: input.taskId,
				}),
			);
		}
		case "create_task": {
			const input = createTaskInput.parse(value);
			requirePin(input.projectId);
			const grant = scopedGrant(client.config, "task.create", input.projectId);
			const operationMode = exactConstraint(grant.constraints.operationMode);
			if (operationMode !== "suggest" && operationMode !== "collaborate") {
				throw new Error("AGENT_CAPABILITY_SCOPE_INVALID");
			}
			return result(
				await client.execute("task.create", {
					...executionScope(grant),
					operationMode,
					title: input.title,
					...(input.description === undefined
						? {}
						: { description: markdownToBlocknote(input.description) }),
					...(input.importance === undefined
						? {}
						: { importance: input.importance }),
					...(input.storyPoints === undefined
						? {}
						: { storyPoints: input.storyPoints }),
					...(input.tags === undefined ? {} : { tags: input.tags }),
				}),
			);
		}
		case "update_task": {
			const input = updateTaskInput.parse(value);
			requirePin(input.projectId);
			const grant = scopedGrant(
				client.config,
				"task.write",
				input.projectId,
				input.taskId,
				input.field,
			);
			const operationMode = exactConstraint(grant.constraints.operationMode);
			if (operationMode !== "suggest" && operationMode !== "collaborate") {
				throw new Error("AGENT_CAPABILITY_SCOPE_INVALID");
			}
			const fieldValue =
				input.field === "description" && typeof input.value === "string"
					? markdownToBlocknote(input.value)
					: input.value;
			return result(
				await client.execute("task.write", {
					...executionScope(grant),
					taskId: input.taskId,
					field: input.field,
					operationMode,
					value: fieldValue,
				}),
			);
		}
		case "discover_tasks":
			z.object({}).strict().parse(value);
			if (!heartbeat) throw new Error("PACA_AGENT_HARNESS_INVALID");
			await client.heartbeat(heartbeat);
			return result(await client.discoverTasks());
		default:
			throw new Error("AGENT_CAPABILITY_TOOL_NOT_FOUND");
	}
}

export function createAgentCapabilityServer(
	client: AgentCapabilityTransport,
	projectPin?: string,
	heartbeat?: AgentHeartbeatReport,
): Server {
	const server = new Server(
		{ name: "paca-agent-auth", version: "0.1.0" },
		{ capabilities: { tools: {} } },
	);
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: getAgentCapabilityTools(client.config),
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		try {
			return await callAgentCapabilityTool(
				client,
				request.params.name,
				request.params.arguments ?? {},
				projectPin,
				heartbeat,
			);
		} catch (error) {
			const code =
				error instanceof Error && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.message)
					? error.message
					: "AGENT_CAPABILITY_TOOL_FAILED";
			return { content: [{ type: "text", text: code }], isError: true };
		}
	});
	return server;
}
