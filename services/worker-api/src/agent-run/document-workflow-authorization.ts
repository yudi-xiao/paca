import type { CapabilityConstraints } from "@better-auth/agent-auth";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { evaluateAgentCapabilityGrant, exactConstraintString } from "../agent-auth/capabilities";
import type { AppBindings } from "../bindings";
import type { PacaDatabase } from "../database";
import { agent, agentCapabilityGrant, pacaDocuments, pacaProjects } from "../db/schema";
import type { DocumentAgentCommandResult } from "../document/agent-operations";
import { PostgresPacaPermissionStore } from "../permission/postgres-store";
import { PacaPermissionService } from "../permission/service";
import type { DocumentAgentWorkflowParams } from "./document-workflow-protocol";

export type PersistedAgentGrant = {
  id: string;
  agentId: string;
  capability: string;
  constraints: CapabilityConstraints | null;
  expiresAt: Date | null;
  status: string;
};

export type DocumentWorkflowAuthorizationDependencies = {
  loadAgent(agentId: string): Promise<{
    id: string;
    mode: string;
    status: string;
    userId: string | null;
    expiresAt: Date | null;
  } | null>;
  loadGrants(agentId: string, grantIds: string[]): Promise<PersistedAgentGrant[]>;
  loadCapabilityGrants(agentId: string): Promise<PersistedAgentGrant[]>;
  readDocumentScope(documentId: string): Promise<{
    organizationId: string;
    projectId: string;
  } | null>;
  hasDocumentWritePermission(
    userId: string,
    projectId: string,
  ): Promise<{
    allowed: boolean;
    scopeExists: boolean;
  }>;
  executeDocumentCommand(
    agentId: string,
    documentId: string,
    command: DocumentAgentWorkflowParams["command"],
    authorizationExpiresAt: number,
  ): Promise<DocumentAgentCommandResult>;
};

export type DocumentWorkflowGrantSelection = {
  workflowGrantId: string;
  documentGrantId: string;
};

export class AgentWorkflowAuthorizationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AgentWorkflowAuthorizationError";
  }
}

function denied(code: string): never {
  throw new AgentWorkflowAuthorizationError(code);
}

function parsedConstraints(value: unknown): CapabilityConstraints | null {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as CapabilityConstraints;
  }
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as CapabilityConstraints)
      : null;
  } catch {
    return null;
  }
}

function requireGrant(
  grants: PersistedAgentGrant[],
  grantId: string,
  capability: "workflow.execute" | "document.edit",
  context: {
    organizationId: string;
    projectId: string;
    documentId?: string;
    workflowId?: string;
    field?: string;
    operationMode: string;
    action?: string;
  },
  now: Date,
): PersistedAgentGrant {
  const grant = grants.find((candidate) => candidate.id === grantId);
  if (!grant || grant.capability !== capability) denied("AGENT_GRANT_REVOKED");
  if (grant.status !== "active") denied("AGENT_GRANT_REVOKED");
  if (grant.expiresAt && grant.expiresAt.getTime() <= now.getTime()) denied("AGENT_GRANT_EXPIRED");
  const decision = evaluateAgentCapabilityGrant(grant, capability, context, now);
  if (!decision.allowed) denied(decision.code);
  return grant;
}

function grantExpiresAt(grant: PersistedAgentGrant): number {
  const constraintExpiry = Date.parse(exactConstraintString(grant.constraints?.validUntil) ?? "");
  const persistedExpiry = grant.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const expiry = Math.min(constraintExpiry, persistedExpiry);
  if (!Number.isFinite(expiry)) denied("AGENT_GRANT_CONSTRAINTS_INVALID");
  return expiry;
}

async function requireCurrentAgentAndScope(
  dependencies: DocumentWorkflowAuthorizationDependencies,
  params: Pick<
    DocumentAgentWorkflowParams,
    "agentId" | "agentMode" | "delegatedUserId" | "organizationId" | "projectId" | "documentId"
  >,
  now: Date,
) {
  const currentAgent = await dependencies.loadAgent(params.agentId);
  if (!currentAgent || currentAgent.status !== "active") denied("AGENT_REVOKED");
  if (currentAgent.expiresAt && currentAgent.expiresAt.getTime() <= now.getTime()) {
    denied("AGENT_EXPIRED");
  }
  if (currentAgent.mode !== params.agentMode || currentAgent.userId !== params.delegatedUserId) {
    denied("AGENT_IDENTITY_CHANGED");
  }

  const scope = await dependencies.readDocumentScope(params.documentId);
  if (
    !scope ||
    scope.organizationId !== params.organizationId ||
    scope.projectId !== params.projectId
  ) {
    denied("AGENT_DOCUMENT_SCOPE_MISMATCH");
  }

  if (params.agentMode === "delegated") {
    if (!params.delegatedUserId) denied("AGENT_DELEGATED_USER_REQUIRED");
    const permission = await dependencies.hasDocumentWritePermission(
      params.delegatedUserId,
      params.projectId,
    );
    if (!permission.scopeExists) denied("AGENT_PROJECT_NOT_FOUND");
    if (!permission.allowed) denied("AGENT_DELEGATED_PERMISSION_DENIED");
  }
}

export async function selectDocumentWorkflowGrants(
  dependencies: DocumentWorkflowAuthorizationDependencies,
  params: Pick<
    DocumentAgentWorkflowParams,
    | "agentId"
    | "agentMode"
    | "delegatedUserId"
    | "workflowId"
    | "organizationId"
    | "projectId"
    | "documentId"
    | "command"
  >,
  now = new Date(),
): Promise<DocumentWorkflowGrantSelection> {
  await requireCurrentAgentAndScope(dependencies, params, now);
  const grants = await dependencies.loadCapabilityGrants(params.agentId);
  const workflowGrant = grants.find(
    (grant) =>
      evaluateAgentCapabilityGrant(
        grant,
        "workflow.execute",
        {
          organizationId: params.organizationId,
          projectId: params.projectId,
          workflowId: params.workflowId,
          operationMode: "execute",
        },
        now,
      ).allowed &&
      (!grant.expiresAt || grant.expiresAt.getTime() > now.getTime()),
  );
  if (!workflowGrant) denied("AGENT_WORKFLOW_GRANT_NOT_ACTIVE");
  const documentGrant = grants.find(
    (grant) =>
      evaluateAgentCapabilityGrant(
        grant,
        "document.edit",
        {
          organizationId: params.organizationId,
          projectId: params.projectId,
          documentId: params.documentId,
          field: "block.content",
          operationMode: params.command.operationMode,
          action: params.command.action,
        },
        now,
      ).allowed &&
      (!grant.expiresAt || grant.expiresAt.getTime() > now.getTime()),
  );
  if (!documentGrant) denied("AGENT_DOCUMENT_GRANT_NOT_ACTIVE");
  return { workflowGrantId: workflowGrant.id, documentGrantId: documentGrant.id };
}

export async function authorizeAndExecuteDocumentWorkflow(
  dependencies: DocumentWorkflowAuthorizationDependencies,
  params: DocumentAgentWorkflowParams,
  now = new Date(),
): Promise<DocumentAgentCommandResult> {
  await requireCurrentAgentAndScope(dependencies, params, now);

  const grants = await dependencies.loadGrants(params.agentId, [
    params.workflowGrantId,
    params.documentGrantId,
  ]);
  requireGrant(
    grants,
    params.workflowGrantId,
    "workflow.execute",
    {
      organizationId: params.organizationId,
      projectId: params.projectId,
      workflowId: params.workflowId,
      operationMode: "execute",
    },
    now,
  );
  const documentGrant = requireGrant(
    grants,
    params.documentGrantId,
    "document.edit",
    {
      organizationId: params.organizationId,
      projectId: params.projectId,
      documentId: params.documentId,
      field: "block.content",
      operationMode: params.command.operationMode,
      action: params.command.action,
    },
    now,
  );

  return dependencies.executeDocumentCommand(
    params.agentId,
    params.documentId,
    params.command,
    grantExpiresAt(documentGrant),
  );
}

export function postgresDocumentWorkflowDependencies(
  database: PacaDatabase,
  env: AppBindings,
): DocumentWorkflowAuthorizationDependencies {
  const permissionService = new PacaPermissionService(new PostgresPacaPermissionStore(database));
  return {
    async loadAgent(agentId) {
      const [row] = await database
        .select({
          id: agent.id,
          mode: agent.mode,
          status: agent.status,
          userId: agent.userId,
          expiresAt: agent.expiresAt,
        })
        .from(agent)
        .where(eq(agent.id, agentId))
        .limit(1);
      return row ?? null;
    },
    async loadGrants(agentId, grantIds) {
      const rows = await database
        .select({
          id: agentCapabilityGrant.id,
          agentId: agentCapabilityGrant.agentId,
          capability: agentCapabilityGrant.capability,
          constraints: agentCapabilityGrant.constraints,
          expiresAt: agentCapabilityGrant.expiresAt,
          status: agentCapabilityGrant.status,
        })
        .from(agentCapabilityGrant)
        .where(
          and(
            eq(agentCapabilityGrant.agentId, agentId),
            inArray(agentCapabilityGrant.id, grantIds),
          ),
        );
      return rows.map((row) => ({ ...row, constraints: parsedConstraints(row.constraints) }));
    },
    async loadCapabilityGrants(agentId) {
      const rows = await database
        .select({
          id: agentCapabilityGrant.id,
          agentId: agentCapabilityGrant.agentId,
          capability: agentCapabilityGrant.capability,
          constraints: agentCapabilityGrant.constraints,
          expiresAt: agentCapabilityGrant.expiresAt,
          status: agentCapabilityGrant.status,
        })
        .from(agentCapabilityGrant)
        .where(
          and(
            eq(agentCapabilityGrant.agentId, agentId),
            inArray(agentCapabilityGrant.capability, ["workflow.execute", "document.edit"]),
          ),
        );
      return rows.map((row) => ({ ...row, constraints: parsedConstraints(row.constraints) }));
    },
    async readDocumentScope(documentId) {
      const [scope] = await database
        .select({
          organizationId: pacaProjects.organizationId,
          projectId: pacaDocuments.projectId,
        })
        .from(pacaDocuments)
        .innerJoin(pacaProjects, eq(pacaProjects.id, pacaDocuments.projectId))
        .where(
          and(
            eq(pacaDocuments.id, documentId),
            isNull(pacaDocuments.deletedAt),
            eq(pacaProjects.status, "active"),
          ),
        )
        .limit(1);
      return scope ?? null;
    },
    hasDocumentWritePermission: async (userId, projectId) =>
      permissionService.hasProjectPermission(userId, projectId, { docs: ["write"] }),
    executeDocumentCommand: (agentId, documentId, command, authorizationExpiresAt) =>
      env.DocumentParty.getByName(documentId).executeAsAgent(
        agentId,
        command,
        authorizationExpiresAt,
      ),
  };
}
