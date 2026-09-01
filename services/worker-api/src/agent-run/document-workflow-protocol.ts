import * as z from "zod";

import { documentAgentCommandSchema } from "../document/agent-operations";

export const DOCUMENT_AGENT_WORKFLOW_ID = "00000000-0000-4000-8000-000000000201";

const transitionIdsSchema = z
  .object({
    running: z.uuid(),
    succeeded: z.uuid(),
    failed: z.uuid(),
  })
  .strict();

export const documentAgentWorkflowParamsSchema = z
  .object({
    version: z.literal(1),
    runId: z.uuid(),
    idempotencyKey: z.uuid(),
    agentId: z.string().min(1).max(255),
    agentMode: z.enum(["delegated", "autonomous"]),
    delegatedUserId: z.string().min(1).max(255).nullable(),
    workflowId: z.literal(DOCUMENT_AGENT_WORKFLOW_ID),
    workflowGrantId: z.string().min(1).max(255),
    documentGrantId: z.string().min(1).max(255),
    organizationId: z.string().min(1).max(255),
    projectId: z.uuid(),
    documentId: z.uuid(),
    command: documentAgentCommandSchema,
    transitionIds: transitionIdsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.command.runId !== value.runId) {
      context.addIssue({ code: "custom", message: "AGENT_RUN_COMMAND_RUN_ID_MISMATCH" });
    }
    if (value.command.requestId !== value.idempotencyKey) {
      context.addIssue({ code: "custom", message: "AGENT_RUN_COMMAND_REQUEST_ID_MISMATCH" });
    }
    if (value.agentMode === "delegated" && !value.delegatedUserId) {
      context.addIssue({ code: "custom", message: "AGENT_DELEGATED_USER_REQUIRED" });
    }
    if (value.agentMode === "autonomous" && value.delegatedUserId) {
      context.addIssue({ code: "custom", message: "AGENT_AUTONOMOUS_USER_INVALID" });
    }
  });

export type DocumentAgentWorkflowParams = z.infer<typeof documentAgentWorkflowParamsSchema>;

export const documentAgentWorkflowStartSchema = z
  .object({
    organizationId: z.string().min(1).max(255),
    documentId: z.uuid(),
    command: documentAgentCommandSchema,
  })
  .strict();

export type DocumentAgentWorkflowStart = z.infer<typeof documentAgentWorkflowStartSchema>;

export function createDocumentAgentWorkflowParams(
  input: Omit<DocumentAgentWorkflowParams, "version" | "transitionIds">,
): DocumentAgentWorkflowParams {
  return documentAgentWorkflowParamsSchema.parse({
    ...input,
    version: 1,
    transitionIds: {
      running: crypto.randomUUID(),
      succeeded: crypto.randomUUID(),
      failed: crypto.randomUUID(),
    },
  });
}

export async function documentAgentWorkflowRequestHash(
  value: DocumentAgentWorkflowStart,
): Promise<string> {
  const input = documentAgentWorkflowStartSchema.parse(value);
  const bytes = new TextEncoder().encode(
    JSON.stringify([input.organizationId, input.documentId, input.command]),
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
