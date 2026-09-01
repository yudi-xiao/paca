import { withDatabase } from "../database";
import type { DocumentAgentCommandResult } from "../document/agent-operations";
import { recordDocumentWorkflowExecution } from "./audit";
import {
  authorizeAndExecuteDocumentWorkflow,
  postgresDocumentWorkflowDependencies,
} from "./document-workflow-authorization";
import { agentWorkflowErrorCode, DocumentAgentWorkflowBase } from "./document-workflow-base";
import type { DocumentAgentWorkflowParams } from "./document-workflow-protocol";

export class DocumentAgentWorkflow extends DocumentAgentWorkflowBase {
  protected override executeDocumentCommand(
    params: DocumentAgentWorkflowParams,
  ): Promise<DocumentAgentCommandResult> {
    return withDatabase(this.env, async (database) => {
      try {
        const result = await authorizeAndExecuteDocumentWorkflow(
          postgresDocumentWorkflowDependencies(database, this.env),
          params,
        );
        await recordDocumentWorkflowExecution(database, params, "succeeded", result);
        return result;
      } catch (error) {
        await recordDocumentWorkflowExecution(
          database,
          params,
          "failed",
          undefined,
          agentWorkflowErrorCode(error),
        );
        throw error;
      }
    });
  }
}
