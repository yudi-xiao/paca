import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import type { DocumentAgentCommandResult } from "../document/agent-operations";
import type { AgentCoordinator } from "./coordinator";
import { AgentWorkflowAuthorizationError } from "./document-workflow-authorization";
import {
  type DocumentAgentWorkflowParams,
  documentAgentWorkflowParamsSchema,
} from "./document-workflow-protocol";

const RETRY = {
  retries: { limit: 4, delay: "2 seconds", backoff: "exponential" as const },
  timeout: "2 minutes",
} as const;

export function agentWorkflowErrorCode(error: unknown): string {
  if (error instanceof AgentWorkflowAuthorizationError) return error.code;
  if (error instanceof Error && /^(AGENT|DOCUMENT)_[A-Z0-9_]{1,90}$/.test(error.message)) {
    return error.message;
  }
  return "AGENT_WORKFLOW_EXECUTION_FAILED";
}

async function requireTransition(
  env: Env,
  agentId: string,
  input: Parameters<DurableObjectStub<AgentCoordinator>["transitionRun"]>[0],
) {
  const result = await env.AgentCoordinator.getByName(agentId).transitionRun(input);
  if (!result.success) throw new Error(result.errorCode);
}

async function markFailedUnlessCancelled(
  env: Env,
  params: DocumentAgentWorkflowParams,
  errorCode: string,
) {
  const coordinator = env.AgentCoordinator.getByName(params.agentId);
  const current = await coordinator.getRun(params.runId);
  if (!current || ["cancelling", "cancelled", "succeeded"].includes(current.status)) return;
  await requireTransition(env, params.agentId, {
    transitionId: params.transitionIds.failed,
    runId: params.runId,
    status: "failed",
    errorCode,
  });
}

export abstract class DocumentAgentWorkflowBase extends WorkflowEntrypoint<
  Env,
  DocumentAgentWorkflowParams
> {
  protected abstract executeDocumentCommand(
    params: DocumentAgentWorkflowParams,
  ): Promise<DocumentAgentCommandResult>;

  override async run(
    event: Readonly<WorkflowEvent<DocumentAgentWorkflowParams>>,
    step: WorkflowStep,
  ) {
    const params = documentAgentWorkflowParamsSchema.parse(event.payload);
    try {
      await step.do("mark-run-running", RETRY, () =>
        requireTransition(this.env, params.agentId, {
          transitionId: params.transitionIds.running,
          runId: params.runId,
          status: "running",
        }),
      );

      const result = await step.do<DocumentAgentCommandResult>(
        "authorize-and-apply-document-command",
        RETRY,
        () => this.executeDocumentCommand(params),
      );

      await step.do("mark-run-succeeded", RETRY, () =>
        requireTransition(this.env, params.agentId, {
          transitionId: params.transitionIds.succeeded,
          runId: params.runId,
          status: "succeeded",
        }),
      );
      return result;
    } catch (error) {
      const errorCode = agentWorkflowErrorCode(error);
      await step.do("mark-run-failed", RETRY, () =>
        markFailedUnlessCancelled(this.env, params, errorCode),
      );
      throw new Error(errorCode);
    }
  }
}
