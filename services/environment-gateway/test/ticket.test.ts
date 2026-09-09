import { describe, expect, it } from "vitest";

import type { TicketClaims } from "../src/protocol";
import { accessTokenFromRequest, signTicket, TicketError, verifyTicket } from "../src/ticket";

const NOW = new Date("2026-09-09T01:00:00.000Z");
const SECRET = "test-only-ticket-secret-with-at-least-32-bytes";

function claims(overrides: Partial<TicketClaims> = {}): TicketClaims {
  const issuedAt = Math.floor(NOW.getTime() / 1000);
  return {
    version: 1,
    jti: "11111111-1111-4111-8111-111111111111",
    environmentId: "22222222-2222-4222-8222-222222222222",
    organizationId: "paca-default",
    projectId: "33333333-3333-4333-8333-333333333333",
    backend: "cloudflare-sandbox",
    reference: "environment-1",
    operationMode: "execute",
    agentId: "agent-1",
    hostId: "host-1",
    issuedAt,
    issuedAtMs: NOW.getTime(),
    expiresAt: issuedAt + 45,
    authorizationExpiresAt: issuedAt + 15 * 60,
    ...overrides,
  };
}

describe("environment connection tickets", () => {
  it("round-trips a bounded HMAC ticket", async () => {
    const token = await signTicket(claims(), SECRET);
    expect(token).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    await expect(verifyTicket(token, SECRET, NOW)).resolves.toEqual(claims());
  });

  it("rejects tampering, weak secrets, expiry, and an excessive lifetime", async () => {
    const token = await signTicket(claims(), SECRET);
    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
    await expect(verifyTicket(tampered, SECRET, NOW)).rejects.toBeInstanceOf(TicketError);
    await expect(signTicket(claims(), "short")).rejects.toMatchObject({
      code: "TICKET_CONFIG_INVALID",
    });
    await expect(
      verifyTicket(token, SECRET, new Date(NOW.getTime() + 45_000)),
    ).rejects.toMatchObject({ code: "TICKET_EXPIRED" });
    await expect(
      signTicket(claims({ expiresAt: claims().issuedAt + 61 }), SECRET),
    ).resolves.toEqual(expect.any(String));
    const excessive = await signTicket(claims({ expiresAt: claims().issuedAt + 61 }), SECRET);
    await expect(verifyTicket(excessive, SECRET, NOW)).rejects.toMatchObject({
      code: "TICKET_EXPIRED",
    });
  });

  it("accepts either a Bearer token or the browser WebSocket subprotocol", () => {
    expect(
      accessTokenFromRequest(
        new Request("https://gateway.test/v1/connect", {
          headers: { authorization: "Bearer v1.payload.signature" },
        }),
      ),
    ).toBe("v1.payload.signature");
    expect(
      accessTokenFromRequest(
        new Request("https://gateway.test/v1/connect", {
          headers: { "sec-websocket-protocol": "paca-ticket.v1.payload.signature" },
        }),
      ),
    ).toBe("v1.payload.signature");
    expect(
      accessTokenFromRequest(
        new Request("https://gateway.test/v1/connect", {
          headers: {
            authorization: "Bearer v1.one.signature",
            "sec-websocket-protocol": "paca-ticket.v1.two.signature",
          },
        }),
      ),
    ).toBeNull();
  });
});
