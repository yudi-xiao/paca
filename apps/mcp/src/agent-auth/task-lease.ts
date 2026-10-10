import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const scope = z.object({
	projectId: z.string().uuid(),
	taskId: z.string().uuid(),
	requestId: z.string().uuid(),
});
const owned = scope.extend({ leaseId: z.string().uuid() });
const duration = z.number().int().min(5000).max(300000);
const key = z
	.string()
	.min(1)
	.max(1024)
	.refine(
		(value) => !value.startsWith("/") && !value.split("/").includes(".."),
	);
const artifacts = z.array(key).max(32).optional();
export const taskLeaseInput = z.discriminatedUnion("action", [
	scope
		.extend({ action: z.literal("claim"), leaseDurationMs: duration })
		.strict(),
	owned
		.extend({ action: z.literal("renew"), leaseDurationMs: duration })
		.strict(),
	owned
		.extend({
			action: z.literal("checkpoint"),
			sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
			checkpointKey: key.nullable().optional(),
			summary: z.string().max(4000).nullable().optional(),
			artifactKeys: artifacts,
		})
		.strict(),
	owned
		.extend({
			action: z.literal("complete"),
			summary: z.string().max(16000).nullable().optional(),
			artifactKeys: artifacts,
		})
		.strict(),
	owned
		.extend({
			action: z.literal("fail"),
			errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/),
			summary: z.string().max(16000).nullable().optional(),
			artifactKeys: artifacts,
		})
		.strict(),
	owned
		.extend({
			action: z.literal("cancel_ack"),
			summary: z.string().max(4000).nullable().optional(),
		})
		.strict(),
]);
const uuid = { type: "string", format: "uuid" };
const scopeProperties = { projectId: uuid, taskId: uuid, requestId: uuid };
const ownedProperties = { ...scopeProperties, leaseId: uuid };
const durationProperty = { type: "integer", minimum: 5000, maximum: 300000 };
const keyProperty = { type: "string", minLength: 1, maxLength: 1024 };
const artifactProperty = { type: "array", maxItems: 32, items: keyProperty };
function variant(
	action: string,
	properties: Record<string, unknown>,
	required: string[] = [],
) {
	return {
		type: "object",
		properties: { ...properties, action: { const: action } },
		required: [
			"projectId",
			"taskId",
			"requestId",
			"action",
			...(action === "claim" ? [] : ["leaseId"]),
			...required,
		],
		additionalProperties: false,
	};
}
export const taskLeaseTool: Tool = {
	name: "execute_task_lease",
	description:
		"Advance an explicitly approved local task.execute lease: claim, renew, checkpoint, complete, fail or acknowledge cancellation. Reuse requestId only when retrying the identical operation. Completion records execution results and does not approve delivery, close the business task, or grant field edits. The server owns leases and enforces cancellation and revocation; local filesystem and shell permissions remain under the coding client's control.",
	inputSchema: {
		type: "object",
		oneOf: [
			variant(
				"claim",
				{ ...scopeProperties, leaseDurationMs: durationProperty },
				["leaseDurationMs"],
			),
			variant(
				"renew",
				{ ...ownedProperties, leaseDurationMs: durationProperty },
				["leaseDurationMs"],
			),
			variant(
				"checkpoint",
				{
					...ownedProperties,
					sequence: {
						type: "integer",
						minimum: 1,
						maximum: Number.MAX_SAFE_INTEGER,
					},
					checkpointKey: { ...keyProperty, type: ["string", "null"] },
					summary: { type: ["string", "null"], maxLength: 4000 },
					artifactKeys: artifactProperty,
				},
				["sequence"],
			),
			variant("complete", {
				...ownedProperties,
				summary: { type: ["string", "null"], maxLength: 16000 },
				artifactKeys: artifactProperty,
			}),
			variant(
				"fail",
				{
					...ownedProperties,
					errorCode: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,99}$" },
					summary: { type: ["string", "null"], maxLength: 16000 },
					artifactKeys: artifactProperty,
				},
				["errorCode"],
			),
			variant("cancel_ack", {
				...ownedProperties,
				summary: { type: ["string", "null"], maxLength: 4000 },
			}),
		],
	},
};
