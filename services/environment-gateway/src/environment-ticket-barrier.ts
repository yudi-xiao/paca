export function isTicketIssuedAfterBarrier(
  ticketIssuedAtMs: number,
  revokedAtMs: number | undefined,
): boolean {
  return (
    Number.isSafeInteger(ticketIssuedAtMs) &&
    ticketIssuedAtMs > 0 &&
    (revokedAtMs === undefined || ticketIssuedAtMs > revokedAtMs)
  );
}
