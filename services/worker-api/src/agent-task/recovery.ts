import type { AppBindings } from "../bindings";
import { withDatabase } from "../database";
import { mirrorHostedTaskLeaseResult } from "./cloudflare-adapter";
import { PostgresAgentTaskLeaseRepository } from "./postgres-repository";

export type AgentTaskRecoveryResult = {
  expired: number;
};

export async function recoverAbandonedAgentTaskLeases(
  env: AppBindings,
  now = new Date(),
): Promise<AgentTaskRecoveryResult> {
  const recovered = await withDatabase(env, (database) =>
    new PostgresAgentTaskLeaseRepository(database).recoverAbandoned(now, 100),
  );
  for (const result of recovered) {
    await mirrorHostedTaskLeaseResult(env, crypto.randomUUID(), result);
  }
  return { expired: recovered.length };
}
