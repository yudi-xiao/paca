import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { startOwnerSetupPage } from "../scripts/lib/owner-setup-page";

describe("private first-owner setup page", () => {
  const email = "owner@example.com";
  const password = randomBytes(24).toString("hex");
  const valid = { email, name: "Owner", password, confirmation: password };

  it("requires exact origin, one-time URL, matching email/password and bounded input", async () => {
    const createOwner = vi.fn(async () => undefined);
    const page = await startOwnerSetupPage({ email, createOwner });
    const origin = new URL(page.url).origin;
    const send = (body: unknown, suppliedOrigin = origin, url = page.url) =>
      fetch(url, {
        method: "POST",
        headers: { origin: suppliedOrigin, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      const response = await fetch(page.url);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect((await fetch(`${origin}/setup/wrong`)).status).toBe(404);
      expect((await send(valid, "https://other.example.com")).status).toBe(403);
      for (const input of [
        { ...valid, email: "other@example.com" },
        { ...valid, confirmation: "different-password" },
        { ...valid, name: "x".repeat(4096) },
        { ...valid, password: "short" },
        { ...valid, unexpected: true },
      ]) {
        expect((await send(input)).status).toBe(400);
      }
      expect(createOwner).not.toHaveBeenCalled();
      expect((await send(valid)).status).toBe(200);
      await expect(page.finished).resolves.toBe("created");
      expect(createOwner).toHaveBeenCalledOnce();
      expect((await send(valid)).status).toBe(404);
    } finally {
      await page.close();
    }
  });

  it("blocks concurrent submissions and allows retry after an atomic creation failure", async () => {
    let rejectPending: (reason: Error) => void = () => undefined;
    const createOwner = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPending = reject;
        }),
    );
    const page = await startOwnerSetupPage({ email, createOwner });
    const send = () =>
      fetch(page.url, {
        method: "POST",
        headers: { origin: new URL(page.url).origin, "content-type": "application/json" },
        body: JSON.stringify(valid),
      });
    try {
      const first = send();
      await vi.waitFor(() => expect(createOwner).toHaveBeenCalledOnce());
      expect((await send()).status).toBe(409);
      rejectPending(new Error("FAILED"));
      expect((await first).status).toBe(400);
      createOwner.mockImplementation(async () => undefined);
      expect((await send()).status).toBe(200);
      await expect(page.finished).resolves.toBe("created");
    } finally {
      await page.close();
    }
  });

  it("expires the URL and settles the operator wait when closed", async () => {
    const page = await startOwnerSetupPage({
      email,
      createOwner: async () => undefined,
      ttlMs: 15,
    });
    await expect(page.finished).resolves.toBe("expired");
    await expect(fetch(page.url)).rejects.toThrow();
    await page.close();
    const cancelled = await startOwnerSetupPage({ email, createOwner: async () => undefined });
    await cancelled.close();
    await expect(cancelled.finished).resolves.toBe("expired");
  });
});
