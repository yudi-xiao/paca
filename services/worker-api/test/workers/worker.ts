export { AgentCoordinator } from "../../src/agent-run/coordinator";

import { DocumentAgentWorkflowBase } from "../../src/agent-run/document-workflow-base";
import type { DocumentAgentWorkflowParams } from "../../src/agent-run/document-workflow-protocol";
import type { DocumentAgentCommandResult } from "../../src/document/agent-operations";

export class TestDocumentAgentWorkflow extends DocumentAgentWorkflowBase {
  protected override executeDocumentCommand(
    _params: DocumentAgentWorkflowParams,
  ): Promise<DocumentAgentCommandResult> {
    throw new Error("TEST_DOCUMENT_STEP_NOT_MOCKED");
  }
}
export { DocumentParty } from "../../src/document/party";
export { ProjectParty, UserParty } from "../../src/realtime/party";

export default {
  fetch(): Response {
    return Response.json({ status: "not_found" }, { status: 404 });
  },
  queue(batch): void {
    batch.ackAll();
  },
} satisfies ExportedHandler<Env>;
