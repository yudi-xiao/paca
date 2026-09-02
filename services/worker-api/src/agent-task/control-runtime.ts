import * as z from "zod";

import type { AppBindings } from "../bindings";
import { withDatabase } from "../database";
import { mirrorHostedTaskLeaseResult } from "./cloudflare-adapter";
import { PostgresAgentTaskLeaseRepository } from "./postgres-repository";
import type { AgentTaskLeaseResult } from "./protocol";

const cancelRequestSchema = z
  .object({
    requestId: z.uuid(),
    reason: z.string().trim().min(1).max(4_000).nullable().default(null),
  })
  .strict();

export type AgentTaskControlRuntime = {
  requestCancel(
    env: AppBindings,
    projectId: string,
    taskId: string,
    requestedBy: string,
    value: unknown,
  ): Promise<AgentTaskLeaseResult>;
};

export const agentTaskControlRuntime: AgentTaskControlRuntime = {
  async requestCancel(env, projectId, taskId, requestedBy, value) {
    const input = cancelRequestSchema.parse(value);
    const result = await withDatabase(env, (database) =>
      new PostgresAgentTaskLeaseRepository(database).requestCancel({
        projectId,
        taskId,
        requestedBy,
        requestId: input.requestId,
        reason: input.reason,
        now: new Date(),
      }),
    );
    await mirrorHostedTaskLeaseResult(env, input.requestId, result);
    return result;
  },
};
