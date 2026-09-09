import { describe, expect, it } from "vitest";

import { isTicketIssuedAfterBarrier } from "../src/environment-ticket-barrier";

describe("environment ticket barrier", () => {
  it("accepts a valid ticket before the Environment has been revoked", () => {
    expect(isTicketIssuedAfterBarrier(1_000, undefined)).toBe(true);
  });

  it("rejects tickets issued at or before the latest revocation", () => {
    expect(isTicketIssuedAfterBarrier(999, 1_000)).toBe(false);
    expect(isTicketIssuedAfterBarrier(1_000, 1_000)).toBe(false);
    expect(isTicketIssuedAfterBarrier(1_001, 1_000)).toBe(true);
  });

  it("rejects malformed issue timestamps", () => {
    expect(isTicketIssuedAfterBarrier(0, undefined)).toBe(false);
    expect(isTicketIssuedAfterBarrier(Number.NaN, undefined)).toBe(false);
    expect(isTicketIssuedAfterBarrier(1.5, undefined)).toBe(false);
  });
});
