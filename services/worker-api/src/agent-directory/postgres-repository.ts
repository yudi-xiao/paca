import { and, asc, eq, inArray, like } from "drizzle-orm";

import type { PacaDatabase } from "../database";
import { agent, agentCapabilityGrant, agentHost, pacaAgentHostRuntimes } from "../db/schema";
import type { ProjectAgentDirectoryCandidate, ProjectAgentDirectoryRepository } from "./service";

/**
 * Agent Auth stores constraints as serialized JSON in its adapter schema.
 * The LIKE predicate is only a coarse database prefilter; the service parses
 * the document and requires an exact projectId (including `{ eq }` form)
 * before returning a row, so malformed or substring-only matches fail closed.
 */
export class PostgresProjectAgentDirectoryRepository implements ProjectAgentDirectoryRepository {
  constructor(private readonly database: PacaDatabase) {}

  async listCandidates(projectId: string): Promise<ProjectAgentDirectoryCandidate[]> {
    const rows = await this.database
      .select({
        agentId: agent.id,
        agentName: agent.name,
        agentStatus: agent.status,
        agentMode: agent.mode,
        agentCreatedAt: agent.createdAt,
        agentUpdatedAt: agent.updatedAt,
        agentLastUsedAt: agent.lastUsedAt,
        agentExpiresAt: agent.expiresAt,
        hostId: agentHost.id,
        hostName: agentHost.name,
        hostStatus: agentHost.status,
        heartbeatExpiresAt: pacaAgentHostRuntimes.heartbeatExpiresAt,
        reportedHarnessKinds: pacaAgentHostRuntimes.reportedHarnessKinds,
        grantId: agentCapabilityGrant.id,
        grantCapability: agentCapabilityGrant.capability,
        grantStatus: agentCapabilityGrant.status,
        grantConstraints: agentCapabilityGrant.constraints,
        grantExpiresAt: agentCapabilityGrant.expiresAt,
        grantCreatedAt: agentCapabilityGrant.createdAt,
        grantUpdatedAt: agentCapabilityGrant.updatedAt,
      })
      .from(agent)
      .innerJoin(
        agentHost,
        and(
          inArray(agent.status, ["active", "pending", "claimed"]),
          eq(agentHost.id, agent.hostId),
        ),
      )
      .innerJoin(
        agentCapabilityGrant,
        and(
          eq(agentCapabilityGrant.agentId, agent.id),
          like(agentCapabilityGrant.constraints, `%${projectId}%`),
        ),
      )
      .leftJoin(pacaAgentHostRuntimes, eq(pacaAgentHostRuntimes.hostId, agentHost.id))
      .orderBy(asc(agent.name), asc(agent.id), asc(agentCapabilityGrant.capability));

    return rows.map((row) => ({
      ...row,
      reportedHarnessKinds: row.reportedHarnessKinds ?? [],
    }));
  }
}
