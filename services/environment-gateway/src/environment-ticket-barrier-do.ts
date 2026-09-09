import { DurableObject } from "cloudflare:workers";

import { isTicketIssuedAfterBarrier } from "./environment-ticket-barrier";

const REVOCATION_BARRIER_KEY = "revocation-barrier-ms";

/**
 * Project-independent barrier for one immutable Environment UUID.
 *
 * The object intentionally stores only a timestamp. Connection/session
 * ownership remains in the principal registry, while this coordination atom
 * makes every pre-issued ticket fail closed after an Environment is archived.
 */
export class EnvironmentTicketBarrierDO extends DurableObject<Env> {
  async isTicketAuthorized(ticketIssuedAtMs: number): Promise<boolean> {
    const revokedAtMs = await this.ctx.storage.get<number>(REVOCATION_BARRIER_KEY);
    return isTicketIssuedAfterBarrier(ticketIssuedAtMs, revokedAtMs);
  }

  async revoke(): Promise<void> {
    await this.ctx.storage.put(REVOCATION_BARRIER_KEY, Date.now());
  }
}
