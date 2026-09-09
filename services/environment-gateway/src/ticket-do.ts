import { DurableObject } from "cloudflare:workers";

export class ConnectionTicketDO extends DurableObject<Env> {
  async consume(expiresAtMs: number): Promise<boolean> {
    const now = Date.now();
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= now || expiresAtMs > now + 60_000) {
      return false;
    }
    const consumed = await this.ctx.storage.transaction(async (transaction) => {
      if (await transaction.get<boolean>("used")) return false;
      await transaction.put({ used: true, expiresAtMs });
      return true;
    });
    if (consumed) await this.ctx.storage.setAlarm(expiresAtMs);
    return consumed;
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
