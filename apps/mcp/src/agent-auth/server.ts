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
const DOCUMENT_AGENT_WORKFLOW_ID = "00000000-0000-4000-8000-000000000201";

function record(value: unknown): JsonRecord | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonRecord)
		: null;
}

function exactOrEqualConstraint(value: unknown): string | null {
	const exact = exactConstraint(value);
	if (exact) return exact;
	const operator = record(value);
	return operator && Object.keys(operator).length === 1
		? exactConstraint(operator.eq)
		: null;
}

function constraintAllows(value: unknown, requested: string): boolean {
	if (exactConstraint(value) === requested) return true;
	const operator = record(value);
	if (!operator || Object.keys(operator).length !== 1) return false;
	if (exactConstraint(operator.eq) === requested) return true;
	return (
		Array.isArray(operator.in) &&
		operator.in.length <= 100 &&
		operator.in.every((item) => typeof item === "string") &&
		operator.in.includes(requested)
	);
}

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
const documentInput = scopeInput
	.extend({ documentId: z.string().uuid() })
	.strict();
const documentTextStyle = z
	.object({
		bold: z.boolean().optional(),
		italic: z.boolean().optional(),
		underline: z.boolean().optional(),
		strike: z.boolean().optional(),
		code: z.boolean().optional(),
		textColor: z.string().min(1).max(100).optional(),
		backgroundColor: z.string().min(1).max(100).optional(),
	})
	.strict();
const documentInlineText = z
	.object({
		type: z.literal("text"),
		text: z.string().max(100_000),
		styles: documentTextStyle.optional(),
	})
	.strict();
const editDocumentInput = documentInput
	.extend({
		requestId: z.string().uuid(),
		runId: z.string().uuid(),
		baseRevision: z.number().int().nonnegative().safe(),
		baseStateVector: z
			.string()
			.min(1)
			.max(400_000)
			.regex(/^[A-Za-z0-9_-]+$/),
		operationMode: z.enum(["suggest", "collaborate"]),
		operations: z
			.array(
				z
					.object({
						type: z.literal("replace_block_content"),
						blockId: z.string().min(1).max(255),
						expectedBlockVersion: z
							.string()
							.min(1)
							.max(400_000)
							.regex(/^[A-Za-z0-9_-]+$/),
						content: z.array(documentInlineText).max(500),
					})
					.strict(),
			)
			.min(1)
			.max(10),
	})
	.strict()
	.superRefine((value, context) => {
		const blockIds = new Set<string>();
		for (const [index, operation] of value.operations.entries()) {
			if (blockIds.has(operation.blockId)) {
				context.addIssue({
					code: "custom",
					message: "DOCUMENT_AGENT_DUPLICATE_BLOCK_TARGET",
					path: ["operations", index, "blockId"],
				});
			}
			blockIds.add(operation.blockId);
		}
	});
const agentRunInput = scopeInput.extend({ runId: z.string().uuid() }).strict();

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

function documentGrant(
	config: AgentAuthConfig,
	capability: "document.read" | "document.edit",
	projectId: string,
	documentId: string,
	input?: { field: string; action: string; operationMode: string },
): AgentGrantRequest {
	return matchingGrant(config, capability, (constraints) => {
		if (
			exactOrEqualConstraint(constraints.projectId) !== projectId ||
			exactOrEqualConstraint(constraints.documentId) !== documentId
		) {
			return false;
		}
		return (
			input === undefined ||
			(constraintAllows(constraints.field, input.field) &&
				constraintAllows(constraints.action, input.action) &&
				constraintAllows(constraints.operationMode, input.operationMode))
		);
	});
}

function workflowGrant(
	config: AgentAuthConfig,
	projectId: string,
): AgentGrantRequest {
	return matchingGrant(config, "workflow.execute", (constraints) =>
		Boolean(
			exactOrEqualConstraint(constraints.projectId) === projectId &&
				constraintAllows(constraints.workflowId, DOCUMENT_AGENT_WORKFLOW_ID) &&
				constraintAllows(constraints.operationMode, "execute"),
		),
	);
}

function executionScope(grant: AgentGrantRequest): JsonRecord {
	const organizationId = exactOrEqualConstraint(
		grant.constraints.organizationId,
	);
	const projectId = exactOrEqualConstraint(grant.constraints.projectId);
	const validUntil = exactOrEqualConstraint(grant.constraints.validUntil);
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
	requestAgent(
		path: string,
		capabilities: string[],
		init: RequestInit,
	): Promise<unknown>;
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
	get_document: {
		name: "get_document",
		description:
			"Read one document snapshot with revision, Yjs state vector, block IDs and block versions.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string", format: "uuid" },
				documentId: { type: "string", format: "uuid" },
			},
			required: ["projectId", "documentId"],
			additionalProperties: false,
		},
	},
	edit_document: {
		name: "edit_document",
		description:
			"Suggest or collaboratively replace content in up to 10 version-checked document blocks.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string", format: "uuid" },
				documentId: { type: "string", format: "uuid" },
				requestId: { type: "string", format: "uuid" },
				runId: { type: "string", format: "uuid" },
				baseRevision: { type: "integer", minimum: 0 },
				baseStateVector: {
					type: "string",
					minLength: 1,
					maxLength: 400_000,
					pattern: "^[A-Za-z0-9_-]+$",
				},
				operationMode: { type: "string", enum: ["suggest", "collaborate"] },
				operations: {
					type: "array",
					minItems: 1,
					maxItems: 10,
					items: {
						type: "object",
						properties: {
							type: { const: "replace_block_content" },
							blockId: { type: "string", minLength: 1, maxLength: 255 },
							expectedBlockVersion: {
								type: "string",
								minLength: 1,
								maxLength: 400_000,
								pattern: "^[A-Za-z0-9_-]+$",
							},
							content: {
								type: "array",
								maxItems: 500,
								items: {
									type: "object",
									properties: {
										type: { const: "text" },
										text: { type: "string", maxLength: 100_000 },
										styles: {
											type: "object",
											properties: {
												bold: { type: "boolean" },
												italic: { type: "boolean" },
												underline: { type: "boolean" },
												strike: { type: "boolean" },
												code: { type: "boolean" },
												textColor: {
													type: "string",
													minLength: 1,
													maxLength: 100,
												},
												backgroundColor: {
													type: "string",
													minLength: 1,
													maxLength: 100,
												},
											},
											additionalProperties: false,
										},
									},
									required: ["type", "text"],
									additionalProperties: false,
								},
							},
						},
						required: ["type", "blockId", "expectedBlockVersion", "content"],
						additionalProperties: false,
					},
				},
			},
			required: [
				"projectId",
				"documentId",
				"requestId",
				"runId",
				"baseRevision",
				"baseStateVector",
				"operationMode",
				"operations",
			],
			additionalProperties: false,
		},
	},
	get_agent_run: {
		name: "get_agent_run",
		description:
			"Read one durable Agent workflow run owned by the current Agent.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string", format: "uuid" },
				runId: { type: "string", format: "uuid" },
			},
			required: ["projectId", "runId"],
			additionalProperties: false,
		},
	},
	cancel_agent_run: {
		name: "cancel_agent_run",
		description:
			"Request cancellation of one durable Agent workflow run; this does not promise content rollback.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string", format: "uuid" },
				runId: { type: "string", format: "uuid" },
			},
			required: ["projectId", "runId"],
			additionalProperties: false,
		},
	},
};

tools.start_document_workflow = {
	name: "start_document_workflow",
	description:
		"Start a durable Cloudflare Workflow for a version-checked document edit and return its Agent run.",
	inputSchema: tools.edit_document.inputSchema,
};

export function getAgentCapabilityTools(config: AgentAuthConfig): Tool[] {
	const requested = new Set(
		config.grantRequests.map((request) => request.capability),
	);
	const available = (capability: string) =>
		config.capabilities.includes(capability) && requested.has(capability);
	const documentWorkflowAvailable =
		available("workflow.execute") &&
		config.grantRequests.some(
			(request) =>
				request.capability === "workflow.execute" &&
				constraintAllows(
					request.constraints.workflowId,
					DOCUMENT_AGENT_WORKFLOW_ID,
				) &&
				constraintAllows(request.constraints.operationMode, "execute"),
		);
	return [
		...(available("project.read") ? [tools.get_project] : []),
		...(available("task.read") ? [tools.get_task] : []),
		...(available("task.create") ? [tools.create_task] : []),
		...(available("task.write") ? [tools.update_task] : []),
		...(available("task.execute") ? [tools.discover_tasks] : []),
		...(available("document.read") ? [tools.get_document] : []),
		...(available("document.edit") ? [tools.edit_document] : []),
		...(documentWorkflowAvailable && available("document.edit")
			? [tools.start_document_workflow]
			: []),
		...(documentWorkflowAvailable
			? [tools.get_agent_run, tools.cancel_agent_run]
			: []),
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
		case "get_document": {
			const input = documentInput.parse(value);
			requirePin(input.projectId);
			const grant = documentGrant(
				client.config,
				"document.read",
				input.projectId,
				input.documentId,
			);
			return result(
				await client.execute("document.read", {
					...executionScope(grant),
					documentId: input.documentId,
				}),
			);
		}
		case "edit_document": {
			const input = editDocumentInput.parse(value);
			requirePin(input.projectId);
			const grant = documentGrant(
				client.config,
				"document.edit",
				input.projectId,
				input.documentId,
				{
					field: "block.content",
					action: "apply",
					operationMode: input.operationMode,
				},
			);
			return result(
				await client.execute("document.edit", {
					...executionScope(grant),
					documentId: input.documentId,
					field: "block.content",
					action: "apply",
					requestId: input.requestId,
					runId: input.runId,
					baseRevision: input.baseRevision,
					baseStateVector: input.baseStateVector,
					operationMode: input.operationMode,
					operations: input.operations.map((operation) => ({
						...operation,
						content: operation.content.map((inline) => ({
							...inline,
							styles: inline.styles ?? {},
						})),
					})),
				}),
			);
		}
		case "start_document_workflow": {
			const input = editDocumentInput.parse(value);
			requirePin(input.projectId);
			const workflow = workflowGrant(client.config, input.projectId);
			const document = documentGrant(
				client.config,
				"document.edit",
				input.projectId,
				input.documentId,
				{
					field: "block.content",
					action: "apply",
					operationMode: input.operationMode,
				},
			);
			const workflowScope = executionScope(workflow);
			const documentScope = executionScope(document);
			if (workflowScope.organizationId !== documentScope.organizationId) {
				throw new Error("AGENT_CAPABILITY_SCOPE_INVALID");
			}
			return result(
				await client.requestAgent(
					`/api/v1/agent/projects/${input.projectId}/workflows/${DOCUMENT_AGENT_WORKFLOW_ID}/runs`,
					["workflow.execute", "document.edit"],
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							organizationId: workflowScope.organizationId,
							documentId: input.documentId,
							command: {
								action: "apply",
								requestId: input.requestId,
								runId: input.runId,
								baseRevision: input.baseRevision,
								baseStateVector: input.baseStateVector,
								operationMode: input.operationMode,
								operations: input.operations.map((operation) => ({
									...operation,
									content: operation.content.map((inline) => ({
										...inline,
										styles: inline.styles ?? {},
									})),
								})),
							},
						}),
					},
				),
			);
		}
		case "get_agent_run":
		case "cancel_agent_run": {
			const input = agentRunInput.parse(value);
			requirePin(input.projectId);
			executionScope(workflowGrant(client.config, input.projectId));
			return result(
				await client.requestAgent(
					`/api/v1/agent/projects/${input.projectId}/workflows/${DOCUMENT_AGENT_WORKFLOW_ID}/runs/${input.runId}`,
					["workflow.execute"],
					{ method: name === "cancel_agent_run" ? "DELETE" : "GET" },
				),
			);
		}
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
