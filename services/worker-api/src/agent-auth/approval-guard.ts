import type { AgentAuthEvent, AgentCapabilityGrant } from "@better-auth/agent-auth";
import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import * as z from "zod";

import type { PacaPermissionService } from "../permission/service";
import {
  areKnownPacaCapabilities,
  exactConstraintString,
  hasValidCapabilityConstraints,
  PACA_AGENT_GRANT_TTL_SECONDS,
  type PacaCapabilityName,
} from "./capabilities";

const approvalBodySchema = z.object({
  agent_id: z.string().optional(),
  approval_id: z.string().optional(),
  action: z.enum(["approve", "deny"]),
  ttl: z.number().positive().max(PACA_AGENT_GRANT_TTL_SECONDS).optional(),
});

const grantBodySchema = z.object({
  agent_id: z.string().min(1),
  capabilities: z
    .array(
      z.union([
        z.string(),
        z.object({
          name: z.string(),
          constraints: z.record(z.string(), z.unknown()).optional(),
        }),
      ]),
    )
    .min(1),
  ttl: z.number().positive().max(PACA_AGENT_GRANT_TTL_SECONDS).optional(),
});

const revokeBodySchema = z.object({
  agent_id: z.string().min(1),
  capabilities: z.array(z.string()).min(1),
});

export type PacaAgentApprovalGuardOptions = {
  permissionService?: PacaPermissionService;
  findProjectOrganization?: (projectId: string) => Promise<string | null>;
  onEvent?: (event: AgentAuthEvent) => void | Promise<void>;
  onCapabilitiesRevoked?: (change: {
    agentId: string;
    documentIds: string[];
    projectIds: string[];
  }) => void | Promise<void>;
};

type ScopedGrant = Pick<AgentCapabilityGrant, "capability" | "constraints">;

function forbidden(code: string): never {
  throw new APIError("FORBIDDEN", { message: code });
}

function badRequest(code: string): never {
  throw new APIError("BAD_REQUEST", { message: code });
}

async function authorizeScopedGrants(
  options: PacaAgentApprovalGuardOptions,
  userId: string,
  grants: ScopedGrant[],
) {
  if (!options.permissionService || !options.findProjectOrganization) {
    throw new APIError("SERVICE_UNAVAILABLE", {
      message: "AGENT_APPROVAL_PERMISSION_SERVICE_UNAVAILABLE",
    });
  }
  if (grants.length === 0) badRequest("AGENT_APPROVAL_PENDING_GRANT_REQUIRED");

  const capabilityNames = grants.map((grant) => grant.capability);
  if (!areKnownPacaCapabilities(capabilityNames)) {
    badRequest("AGENT_APPROVAL_CAPABILITY_INVALID");
  }

  const scopes = new Map<string, string>();
  for (const grant of grants) {
    const capability = grant.capability as PacaCapabilityName;
    if (!hasValidCapabilityConstraints(capability, grant.constraints)) {
      badRequest("AGENT_APPROVAL_CONSTRAINTS_INVALID");
    }
    const organizationId = exactConstraintString(grant.constraints?.organizationId);
    const projectId = exactConstraintString(grant.constraints?.projectId);
    if (!organizationId || !projectId) {
      badRequest("AGENT_APPROVAL_PROJECT_SCOPE_REQUIRED");
    }
    const existingOrganization = scopes.get(projectId);
    if (existingOrganization && existingOrganization !== organizationId) {
      badRequest("AGENT_APPROVAL_SCOPE_CONFLICT");
    }
    scopes.set(projectId, organizationId);
  }

  for (const [projectId, organizationId] of scopes) {
    const actualOrganizationId = await options.findProjectOrganization(projectId);
    if (!actualOrganizationId || actualOrganizationId !== organizationId) {
      forbidden("AGENT_APPROVAL_PROJECT_SCOPE_MISMATCH");
    }
    const decision = await options.permissionService.hasProjectPermission(userId, projectId, {
      agents: ["approveGrant"],
    });
    if (!decision.scopeExists) forbidden("AGENT_APPROVAL_PROJECT_NOT_FOUND");
    if (!decision.allowed) forbidden("AGENT_APPROVAL_PERMISSION_DENIED");
  }
}

/**
 * Agent Auth owns the approval lifecycle; this companion plugin adds Paca's
 * project-domain approval permission and validates the proposed grant scope
 * before the Agent Auth endpoint can activate it.
 */
export function pacaAgentApprovalGuard(options: PacaAgentApprovalGuardOptions = {}) {
  return {
    id: "paca-agent-approval-guard",
    endpoints: {
      revokePacaAgentCapability: createAuthEndpoint(
        "/paca-agent/revoke-capability",
        { method: "POST", body: revokeBodySchema },
        async (context) => {
          const session = await getSessionFromCtx(context, { disableCookieCache: true });
          if (!session) throw new APIError("UNAUTHORIZED");

          const grants = await context.context.adapter.findMany<AgentCapabilityGrant>({
            model: "agentCapabilityGrant",
            where: [{ field: "agentId", value: context.body.agent_id }],
          });
          const requested = new Set(context.body.capabilities);
          const revocable = grants.filter(
            (grant) => requested.has(grant.capability) && grant.status !== "revoked",
          );
          await authorizeScopedGrants(options, session.user.id, revocable);

          const now = new Date();
          for (const grant of revocable) {
            await context.context.adapter.update({
              model: "agentCapabilityGrant",
              where: [{ field: "id", value: grant.id }],
              update: { status: "revoked", updatedAt: now },
            });
          }

          await options.onEvent?.({
            type: "capability.revoked",
            actorType: "user",
            actorId: session.user.id,
            agentId: context.body.agent_id,
            metadata: {
              capabilities: revocable.map((grant) => grant.capability),
              grantIds: revocable.map((grant) => grant.id),
            },
          });

          const projectIds = [
            ...new Set(
              revocable
                .map((grant) => exactConstraintString(grant.constraints?.projectId))
                .filter((projectId): projectId is string => Boolean(projectId)),
            ),
          ];
          const documentIds = [
            ...new Set(
              revocable
                .map((grant) => exactConstraintString(grant.constraints?.documentId))
                .filter((documentId): documentId is string => Boolean(documentId)),
            ),
          ];
          await options.onCapabilitiesRevoked?.({
            agentId: context.body.agent_id,
            documentIds,
            projectIds,
          });

          return context.json({
            agent_id: context.body.agent_id,
            revoked: revocable.map((grant) => grant.capability),
            grant_ids: revocable.map((grant) => grant.id),
          });
        },
      ),
    },
    hooks: {
      before: [
        {
          matcher: (context) =>
            context.path === "/agent/approve-capability" ||
            context.path === "/agent/grant-capability",
          handler: createAuthMiddleware(async (context) => {
            const session = await getSessionFromCtx(context, { disableCookieCache: true });
            if (!session) throw new APIError("UNAUTHORIZED");

            if (context.path === "/agent/grant-capability") {
              const body = grantBodySchema.safeParse(context.body);
              if (!body.success) badRequest("AGENT_APPROVAL_REQUEST_INVALID");
              await authorizeScopedGrants(
                options,
                session.user.id,
                body.data.capabilities.map((capability) =>
                  typeof capability === "string"
                    ? { capability, constraints: null }
                    : {
                        capability: capability.name,
                        constraints:
                          (capability.constraints as AgentCapabilityGrant["constraints"]) ?? null,
                      },
                ),
              );
              return;
            }

            const body = approvalBodySchema.safeParse(context.body);
            if (!body.success) badRequest("AGENT_APPROVAL_REQUEST_INVALID");
            let agentId = body.data.agent_id;
            if (!agentId && body.data.approval_id) {
              const approval = await context.context.adapter.findOne<{ agentId: string | null }>({
                model: "approvalRequest",
                where: [{ field: "id", value: body.data.approval_id }],
              });
              agentId = approval?.agentId ?? undefined;
            }
            if (!agentId) badRequest("AGENT_APPROVAL_AGENT_REQUIRED");

            const grants = await context.context.adapter.findMany<AgentCapabilityGrant>({
              model: "agentCapabilityGrant",
              where: [
                { field: "agentId", value: agentId },
                { field: "status", value: "pending" },
              ],
            });
            await authorizeScopedGrants(options, session.user.id, grants);
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
