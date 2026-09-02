import { and, eq, getTableColumns, inArray, sql } from "drizzle-orm";

import type { PacaDatabase } from "../database";
import {
  agentHost,
  pacaAgentHostRuntimes,
  pacaAgentTaskRequirements,
  pacaTasks,
} from "../db/schema";
import {
  AGENT_HOST_HEARTBEAT_TTL_MS,
  type AgentHostHeartbeat,
  AgentHostRuntimeError,
  type AgentHostRuntimeProfile,
  type AgentHostRuntimeRepository,
  agentHostMatchesTask,
  agentHostRuntimeErrorCodes,
  effectiveAgentHostLabels,
} from "./host-runtime";

type HostRuntimeRow = typeof pacaAgentHostRuntimes.$inferSelect & {
  hostName: string | null;
  hostStatus: string;
};

function runtimeProfile(row: HostRuntimeRow, now: Date): AgentHostRuntimeProfile {
  const effectiveLabels = effectiveAgentHostLabels(row.approvedLabels, row.reportedLabels);
  return {
    hostId: row.hostId,
    hostName: row.hostName,
    hostStatus: row.hostStatus,
    approvedLabels: [...row.approvedLabels].sort(),
    reportedLabels: [...row.reportedLabels].sort(),
    reportedHarnessKinds: [...row.reportedHarnessKinds].sort(),
    effectiveLabels,
    labelsVersion: row.labelsVersion,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt,
    lastHeartbeatAt: row.lastHeartbeatAt,
    heartbeatExpiresAt: row.heartbeatExpiresAt,
    online:
      row.hostStatus === "active" &&
      row.heartbeatExpiresAt !== null &&
      row.heartbeatExpiresAt.getTime() > now.getTime(),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PostgresAgentHostRuntimeRepository implements AgentHostRuntimeRepository {
  constructor(private readonly database: PacaDatabase) {}

  private async host(hostId: string) {
    const [host] = await this.database
      .select({ id: agentHost.id, name: agentHost.name, status: agentHost.status })
      .from(agentHost)
      .where(eq(agentHost.id, hostId))
      .limit(1);
    if (!host) throw new AgentHostRuntimeError(agentHostRuntimeErrorCodes.hostNotFound);
    if (host.status !== "active") {
      throw new AgentHostRuntimeError(agentHostRuntimeErrorCodes.hostInactive);
    }
    return host;
  }

  private async findProfile(hostId: string, now: Date): Promise<AgentHostRuntimeProfile | null> {
    const [row] = await this.database
      .select({
        ...getTableColumns(pacaAgentHostRuntimes),
        hostName: agentHost.name,
        hostStatus: agentHost.status,
      })
      .from(pacaAgentHostRuntimes)
      .innerJoin(agentHost, eq(agentHost.id, pacaAgentHostRuntimes.hostId))
      .where(eq(pacaAgentHostRuntimes.hostId, hostId))
      .limit(1);
    return row ? runtimeProfile(row, now) : null;
  }

  private async profile(hostId: string, now: Date): Promise<AgentHostRuntimeProfile> {
    const profile = await this.findProfile(hostId, now);
    if (!profile) throw new AgentHostRuntimeError(agentHostRuntimeErrorCodes.hostNotFound);
    return profile;
  }

  async heartbeat(
    hostId: string,
    input: AgentHostHeartbeat,
    now: Date,
  ): Promise<AgentHostRuntimeProfile> {
    await this.host(hostId);
    const expiresAt = new Date(now.getTime() + AGENT_HOST_HEARTBEAT_TTL_MS);
    await this.database
      .insert(pacaAgentHostRuntimes)
      .values({
        hostId,
        reportedLabels: input.labels,
        reportedHarnessKinds: input.harnesses.map(({ kind }) => kind),
        lastHeartbeatAt: now,
        heartbeatExpiresAt: expiresAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: pacaAgentHostRuntimes.hostId,
        set: {
          reportedLabels: input.labels,
          reportedHarnessKinds: input.harnesses.map(({ kind }) => kind),
          lastHeartbeatAt: now,
          heartbeatExpiresAt: expiresAt,
          updatedAt: now,
        },
      });
    return this.profile(hostId, now);
  }

  async approveLabels(
    hostId: string,
    approvedBy: string,
    labels: string[],
    now: Date,
  ): Promise<AgentHostRuntimeProfile> {
    await this.host(hostId);
    await this.database
      .insert(pacaAgentHostRuntimes)
      .values({
        hostId,
        approvedLabels: labels,
        labelsVersion: 1,
        approvedBy,
        approvedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: pacaAgentHostRuntimes.hostId,
        set: {
          approvedLabels: labels,
          labelsVersion: sql`${pacaAgentHostRuntimes.labelsVersion} + 1`,
          approvedBy,
          approvedAt: now,
          updatedAt: now,
        },
      });
    return this.profile(hostId, now);
  }

  async list(now: Date): Promise<AgentHostRuntimeProfile[]> {
    const rows = await this.database
      .select({
        ...getTableColumns(pacaAgentHostRuntimes),
        hostName: agentHost.name,
        hostStatus: agentHost.status,
      })
      .from(pacaAgentHostRuntimes)
      .innerJoin(agentHost, eq(agentHost.id, pacaAgentHostRuntimes.hostId))
      .orderBy(agentHost.name, agentHost.id);
    return rows.map((row) => runtimeProfile(row, now));
  }

  async matchTasks(hostId: string, taskIds: readonly string[], now: Date): Promise<Set<string>> {
    if (taskIds.length === 0) return new Set();
    const profile = await this.findProfile(hostId, now);
    if (!profile) return new Set();
    if (!profile.online) return new Set();
    if (!agentHostMatchesTask(profile, [])) return new Set();

    const requirements = await this.database
      .select({
        taskId: pacaAgentTaskRequirements.taskId,
        labels: pacaAgentTaskRequirements.requiredLabels,
      })
      .from(pacaAgentTaskRequirements)
      .where(inArray(pacaAgentTaskRequirements.taskId, [...taskIds]));
    const labelsByTask = new Map(requirements.map(({ taskId, labels }) => [taskId, labels]));
    return new Set(
      taskIds.filter((taskId) => agentHostMatchesTask(profile, labelsByTask.get(taskId) ?? [])),
    );
  }

  async getTaskRequirement(projectId: string, taskId: string) {
    const [task] = await this.database
      .select({ id: pacaTasks.id })
      .from(pacaTasks)
      .where(and(eq(pacaTasks.id, taskId), eq(pacaTasks.projectId, projectId)))
      .limit(1);
    if (!task) throw new AgentHostRuntimeError(agentHostRuntimeErrorCodes.taskNotFound);
    const [requirement] = await this.database
      .select()
      .from(pacaAgentTaskRequirements)
      .where(
        and(
          eq(pacaAgentTaskRequirements.taskId, taskId),
          eq(pacaAgentTaskRequirements.projectId, projectId),
        ),
      )
      .limit(1);
    return requirement ?? null;
  }

  async setTaskRequirement(
    projectId: string,
    taskId: string,
    updatedBy: string,
    labels: string[],
    now: Date,
  ) {
    await this.getTaskRequirement(projectId, taskId);
    const [requirement] = await this.database
      .insert(pacaAgentTaskRequirements)
      .values({ projectId, taskId, requiredLabels: labels, updatedBy, updatedAt: now })
      .onConflictDoUpdate({
        target: pacaAgentTaskRequirements.taskId,
        set: { requiredLabels: labels, updatedBy, updatedAt: now },
      })
      .returning();
    if (!requirement) throw new AgentHostRuntimeError(agentHostRuntimeErrorCodes.taskNotFound);
    return requirement;
  }
}
