import { DurableObject } from "cloudflare:workers";

import {
  type ActiveEnvironmentConnection,
  activeEnvironmentConnectionSchema,
  MAX_AUTHORIZATION_TTL_SECONDS,
} from "./protocol";
import { CloudflareSandboxProvider } from "./provider";

const CONNECTION_PREFIX = "connection:";
const REVOCATION_BARRIER_KEY = "revocation-barrier-ms";
const REVOCATION_RETRY_KEY = "revocation-retry-attempt";
const MAX_CONNECTIONS_PER_AGENT = 100;
const REVOCATION_RETRY_MS = 5_000;
const MAX_REVOCATION_RETRY_MS = 60_000;

export type ConnectionRevocationResult = {
  terminated: number;
  pending: number;
};

export class AgentConnectionRegistryDO extends DurableObject<Env> {
  private key(connectionId: string): string {
    return `${CONNECTION_PREFIX}${connectionId}`;
  }

  private async records(): Promise<Map<string, ActiveEnvironmentConnection>> {
    const stored = await this.ctx.storage.list<unknown>({ prefix: CONNECTION_PREFIX });
    const records = new Map<string, ActiveEnvironmentConnection>();
    for (const [key, value] of stored) {
      const parsed = activeEnvironmentConnectionSchema.safeParse(value);
      if (parsed.success) records.set(key, parsed.data);
      else await this.ctx.storage.delete(key);
    }
    return records;
  }

  private async schedule(records?: Iterable<ActiveEnvironmentConnection>): Promise<void> {
    const values = records ? [...records] : [...(await this.records()).values()];
    if (values.length === 0) {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.delete(REVOCATION_RETRY_KEY);
      return;
    }
    const earliest = Math.min(...values.map((connection) => connection.authorizationExpiresAtMs));
    const currentAlarm = await this.ctx.storage.getAlarm();
    const scheduled = Math.max(Date.now() + 1, earliest);
    await this.ctx.storage.setAlarm(
      currentAlarm !== null && currentAlarm > Date.now()
        ? Math.min(currentAlarm, scheduled)
        : scheduled,
    );
  }

  async register(value: ActiveEnvironmentConnection): Promise<boolean> {
    const connection = activeEnvironmentConnectionSchema.parse(value);
    const now = Date.now();
    if (
      connection.authorizationExpiresAtMs <= now ||
      connection.authorizationExpiresAtMs > now + MAX_AUTHORIZATION_TTL_SECONDS * 1_000
    ) {
      throw new Error("GATEWAY_CONNECTION_AUTHORIZATION_INVALID");
    }
    const accepted = await this.ctx.storage.transaction(async (transaction) => {
      const revokedAtMs = await transaction.get<number>(REVOCATION_BARRIER_KEY);
      if (revokedAtMs !== undefined && connection.ticketIssuedAtMs <= revokedAtMs) return false;

      const stored = await transaction.list<unknown>({ prefix: CONNECTION_PREFIX });
      const records = new Map<string, ActiveEnvironmentConnection>();
      for (const [key, item] of stored) {
        const parsed = activeEnvironmentConnectionSchema.safeParse(item);
        if (parsed.success) records.set(key, parsed.data);
        else await transaction.delete(key);
      }
      if (
        !records.has(this.key(connection.connectionId)) &&
        records.size >= MAX_CONNECTIONS_PER_AGENT
      ) {
        throw new Error("GATEWAY_AGENT_CONNECTION_LIMIT_EXCEEDED");
      }
      await transaction.put(this.key(connection.connectionId), connection);
      return true;
    });
    if (accepted) await this.schedule();
    return accepted;
  }

  async isTicketAuthorized(ticketIssuedAtMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(ticketIssuedAtMs) || ticketIssuedAtMs <= 0) return false;
    const revokedAtMs = await this.ctx.storage.get<number>(REVOCATION_BARRIER_KEY);
    return revokedAtMs === undefined || ticketIssuedAtMs > revokedAtMs;
  }

  async unregister(connectionId: string): Promise<void> {
    await this.ctx.storage.delete(this.key(connectionId));
    await this.schedule();
  }

  private async terminate(
    records: Map<string, ActiveEnvironmentConnection>,
  ): Promise<ConnectionRevocationResult> {
    const provider = new CloudflareSandboxProvider(this.env);
    let terminated = 0;
    let pending = 0;
    for (const [key, connection] of records) {
      try {
        await provider.terminate(connection, connection.sessionId);
        await this.ctx.storage.delete(key);
        terminated += 1;
      } catch {
        pending += 1;
        console.error(
          JSON.stringify({
            level: "error",
            message: "environment.session.termination_failed",
            connectionId: connection.connectionId,
            environmentId: connection.environmentId,
            backend: connection.backend,
          }),
        );
      }
    }
    if (pending > 0) {
      const attempt = (await this.ctx.storage.get<number>(REVOCATION_RETRY_KEY)) ?? 0;
      const nextAttempt = Math.min(attempt + 1, 32);
      const delay = Math.min(
        REVOCATION_RETRY_MS * 2 ** Math.min(nextAttempt - 1, 4),
        MAX_REVOCATION_RETRY_MS,
      );
      await this.ctx.storage.put(REVOCATION_RETRY_KEY, nextAttempt);
      await this.ctx.storage.setAlarm(Date.now() + delay);
    } else {
      await this.ctx.storage.delete(REVOCATION_RETRY_KEY);
      await this.schedule();
    }
    return { terminated, pending };
  }

  async revokeAll(): Promise<ConnectionRevocationResult> {
    const records = await this.ctx.storage.transaction(async (transaction) => {
      await transaction.put(REVOCATION_BARRIER_KEY, Date.now());
      const stored = await transaction.list<unknown>({ prefix: CONNECTION_PREFIX });
      const active = new Map<string, ActiveEnvironmentConnection>();
      for (const [key, value] of stored) {
        const parsed = activeEnvironmentConnectionSchema.safeParse(value);
        if (parsed.success) active.set(key, parsed.data);
        else await transaction.delete(key);
      }
      return active;
    });
    return this.terminate(records);
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const records = await this.records();
    const expired = new Map(
      [...records].filter(([, connection]) => connection.authorizationExpiresAtMs <= now),
    );
    if (expired.size > 0) await this.terminate(expired);
    else await this.schedule(records.values());
  }
}
