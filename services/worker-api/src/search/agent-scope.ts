import type { AgentSession } from "@better-auth/agent-auth";
import * as z from "zod";
import { evaluateAgentCapabilityGrant, exactConstraintString } from "../agent-auth/capabilities";
import { ProjectSearchError, type SearchKind } from "./service";

function identifiers(value: unknown): string[] {
  const exact = exactConstraintString(value);
  if (exact) return z.uuid().safeParse(exact).success ? [exact] : [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const parsed = z
    .object({ in: z.array(z.uuid()).min(1).max(100) })
    .strict()
    .safeParse(value);
  return parsed.success ? parsed.data.in : [];
}
/** Resolve explicit readable resources from live grants; neither project.read
 * nor a client-supplied ID list grants permission to search task/doc bodies. */
export function agentSearchIds(
  session: AgentSession,
  projectId: string,
  organizationId: string,
  kind: SearchKind,
  now = new Date(),
): string[] {
  if (!session.host || session.host.id !== session.agent.hostId || session.host.status !== "active")
    throw new ProjectSearchError("SEARCH_SCOPE_DENIED");
  const capability = kind === "tasks" ? "task.read" : "document.read";
  const key = kind === "tasks" ? "taskId" : "documentId";
  const ids = new Set<string>();
  for (const grant of session.agent.capabilityGrants) {
    if (grant.capability !== capability || grant.status !== "active") continue;
    const constraints = grant.constraints;
    const validUntil = exactConstraintString(constraints?.validUntil);
    if (
      exactConstraintString(constraints?.organizationId) !== organizationId ||
      exactConstraintString(constraints?.projectId) !== projectId ||
      !validUntil
    )
      continue;
    for (const id of identifiers(constraints?.[key])) {
      const decision = evaluateAgentCapabilityGrant(
        grant,
        capability,
        { organizationId, projectId, [key]: id },
        now,
      );
      if (decision.allowed) ids.add(id);
      if (ids.size > 100) throw new ProjectSearchError("SEARCH_SCOPE_DENIED");
    }
  }
  if (ids.size === 0) throw new ProjectSearchError("SEARCH_SCOPE_DENIED");
  return [...ids].sort();
}
