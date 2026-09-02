import * as z from "zod";

import type { AppBindings } from "../bindings";
import type { AgentTaskLeaseCommand, AgentTaskLeaseResult } from "./protocol";

export const hostedTaskLeaseMirrorSchema = z
  .object({
    requestId: z.uuid(),
    leaseId: z.uuid(),
    organizationId: z.string().min(1).max(255),
    projectId: z.uuid(),
    taskId: z.uuid(),
    agentId: z.string().min(1).max(255),
    hostId: z.string().min(1).max(255),
    harnessKind: z.literal("cloudflare-agent"),
    status: z.enum(["active", "cancelled", "completed", "expired", "failed"]),
    version: z.number().int().positive(),
    lastCheckpointSequence: z.number().int().nonnegative(),
    leaseExpiresAt: z.number().int().nonnegative(),
    finishedAt: z.number().int().nonnegative().nullable(),
    errorCode: z.string().min(1).max(100).nullable(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export type HostedTaskLeaseMirror = z.infer<typeof hostedTaskLeaseMirrorSchema>;

export function hostedTaskLeaseMirror(
  command: AgentTaskLeaseCommand,
  result: AgentTaskLeaseResult,
): HostedTaskLeaseMirror | null {
  return hostedTaskLeaseMirrorForRequest(command.requestId, result);
}

export function hostedTaskLeaseMirrorForRequest(
  requestId: string,
  result: AgentTaskLeaseResult,
): HostedTaskLeaseMirror | null {
  const lease = result.lease;
  if (lease.harness.kind !== "cloudflare-agent") return null;
  return hostedTaskLeaseMirrorSchema.parse({
    requestId,
    leaseId: lease.id,
    organizationId: lease.organizationId,
    projectId: lease.projectId,
    taskId: lease.taskId,
    agentId: lease.agentId,
    hostId: lease.hostId,
    harnessKind: lease.harness.kind,
    status: lease.status,
    version: lease.version,
    lastCheckpointSequence: lease.lastCheckpointSequence,
    leaseExpiresAt: lease.leaseExpiresAt.getTime(),
    finishedAt: lease.finishedAt?.getTime() ?? null,
    errorCode: lease.errorCode,
    updatedAt: lease.updatedAt.getTime(),
  });
}

/**
 * Bridges an already-authorized PostgreSQL lease into the Cloudflare AgentDO.
 * The mirror is deliberately not an authorization or business-data source.
 */
export async function mirrorHostedTaskLease(
  env: Pick<AppBindings, "AgentCoordinator">,
  command: AgentTaskLeaseCommand,
  result: AgentTaskLeaseResult,
): Promise<void> {
  const mirror = hostedTaskLeaseMirror(command, result);
  if (!mirror) return;
  const accepted = await env.AgentCoordinator.getByName(mirror.agentId).recordTaskLease(mirror);
  if (!accepted.success) throw new Error(accepted.errorCode);
}

export async function mirrorHostedTaskLeaseResult(
  env: Pick<AppBindings, "AgentCoordinator">,
  requestId: string,
  result: AgentTaskLeaseResult,
): Promise<void> {
  const mirror = hostedTaskLeaseMirrorForRequest(requestId, result);
  if (!mirror) return;
  const accepted = await env.AgentCoordinator.getByName(mirror.agentId).recordTaskLease(mirror);
  if (!accepted.success) throw new Error(accepted.errorCode);
}
