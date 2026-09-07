import * as z from "zod";

import { exactConstraintString } from "../agent-auth/capabilities";

const constraintsSchema = z.record(z.string(), z.unknown());

export type ProjectAgentGrantStatus = "active" | "pending" | "inactive";

export type ProjectAgentDirectoryGrant = {
  id: string;
  capability: string;
  status: ProjectAgentGrantStatus;
  validUntil: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ProjectAgentDirectoryItem = {
  agentId: string;
  name: string;
  status: string;
  mode: string;
  hostId: string;
  hostName: string | null;
  hostStatus: string;
  hostOnline: boolean;
  harnessKinds: string[];
  authorizationStatus: ProjectAgentGrantStatus;
  capabilityGrants: ProjectAgentDirectoryGrant[];
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
};

export type ProjectAgentDirectoryCandidate = {
  agentId: string;
  agentName: string;
  agentStatus: string;
  agentMode: string;
  agentCreatedAt: Date;
  agentUpdatedAt: Date;
  agentLastUsedAt: Date | null;
  agentExpiresAt: Date | null;
  hostId: string;
  hostName: string | null;
  hostStatus: string;
  heartbeatExpiresAt: Date | null;
  reportedHarnessKinds: string[];
  grantId: string;
  grantCapability: string;
  grantStatus: string;
  grantConstraints: string | null;
  grantExpiresAt: Date | null;
  grantCreatedAt: Date;
  grantUpdatedAt: Date;
};

export interface ProjectAgentDirectoryRepository {
  listCandidates(projectId: string): Promise<ProjectAgentDirectoryCandidate[]>;
}

function grantScope(
  candidate: ProjectAgentDirectoryCandidate,
  projectId: string,
): { validUntil: Date | null } | null {
  if (!candidate.grantConstraints) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(candidate.grantConstraints);
  } catch {
    return null;
  }
  const constraints = constraintsSchema.safeParse(raw);
  if (!constraints.success) return null;
  if (exactConstraintString(constraints.data.projectId) !== projectId) return null;

  const validUntilValue = exactConstraintString(constraints.data.validUntil);
  if (!validUntilValue) return { validUntil: null };
  const validUntil = new Date(validUntilValue);
  return Number.isNaN(validUntil.getTime()) ? { validUntil: null } : { validUntil };
}

function grantStatus(
  candidate: ProjectAgentDirectoryCandidate,
  validUntil: Date | null,
  now: Date,
): ProjectAgentGrantStatus {
  const withinGrantExpiry = !candidate.grantExpiresAt || candidate.grantExpiresAt > now;
  const withinConstraintExpiry = Boolean(validUntil && validUntil > now);
  if (candidate.grantStatus === "active" && withinGrantExpiry && withinConstraintExpiry) {
    return "active";
  }
  if (candidate.grantStatus === "pending" && withinGrantExpiry && withinConstraintExpiry) {
    return "pending";
  }
  return "inactive";
}

function strongestStatus(statuses: readonly ProjectAgentGrantStatus[]): ProjectAgentGrantStatus {
  if (statuses.includes("active")) return "active";
  if (statuses.includes("pending")) return "pending";
  return "inactive";
}

/**
 * Produces a project-scoped, secret-free Agent Auth directory. Historical
 * scoped grants keep an Agent discoverable, while authorizationStatus makes
 * it explicit that only a currently active Grant authorizes execution.
 */
export class ProjectAgentDirectoryService {
  constructor(private readonly repository: ProjectAgentDirectoryRepository) {}

  async list(projectId: string, now = new Date()): Promise<ProjectAgentDirectoryItem[]> {
    const candidates = await this.repository.listCandidates(projectId);
    const agents = new Map<string, ProjectAgentDirectoryItem>();
    const latestGrantByAgentCapability = new Map<
      string,
      { candidate: ProjectAgentDirectoryCandidate; grant: ProjectAgentDirectoryGrant }
    >();

    for (const candidate of candidates) {
      const scope = grantScope(candidate, projectId);
      if (!scope) continue;
      const grant: ProjectAgentDirectoryGrant = {
        id: candidate.grantId,
        capability: candidate.grantCapability,
        status: grantStatus(candidate, scope.validUntil, now),
        validUntil: scope.validUntil,
        expiresAt: candidate.grantExpiresAt,
        createdAt: candidate.grantCreatedAt,
        updatedAt: candidate.grantUpdatedAt,
      };
      const key = `${candidate.agentId}\u0000${candidate.grantCapability}`;
      const current = latestGrantByAgentCapability.get(key);
      if (!current || current.candidate.grantCreatedAt < candidate.grantCreatedAt) {
        latestGrantByAgentCapability.set(key, { candidate, grant });
      }
    }

    for (const { candidate, grant } of latestGrantByAgentCapability.values()) {
      const item = agents.get(candidate.agentId) ?? {
        agentId: candidate.agentId,
        name: candidate.agentName,
        status: candidate.agentStatus,
        mode: candidate.agentMode,
        hostId: candidate.hostId,
        hostName: candidate.hostName,
        hostStatus: candidate.hostStatus,
        hostOnline:
          candidate.hostStatus === "active" &&
          Boolean(candidate.heartbeatExpiresAt && candidate.heartbeatExpiresAt > now),
        harnessKinds: [...new Set(candidate.reportedHarnessKinds)].sort(),
        authorizationStatus: "inactive" as const,
        capabilityGrants: [],
        createdAt: candidate.agentCreatedAt,
        updatedAt: candidate.agentUpdatedAt,
        lastUsedAt: candidate.agentLastUsedAt,
        expiresAt: candidate.agentExpiresAt,
      };
      item.capabilityGrants.push(grant);
      agents.set(candidate.agentId, item);
    }

    return [...agents.values()]
      .map((item) => ({
        ...item,
        authorizationStatus: strongestStatus(item.capabilityGrants.map(({ status }) => status)),
        capabilityGrants: item.capabilityGrants.sort((left, right) =>
          left.capability.localeCompare(right.capability),
        ),
      }))
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name) || left.agentId.localeCompare(right.agentId),
      );
  }
}
