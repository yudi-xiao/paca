import { describe, expect, it, vi } from "vitest";
import { configureGitHubAppWebhook } from "../scripts/github-app-webhook";

const origin = "https://paca-internal.howlearnwood.com";
const desired = {
  url: `${origin}/api/integrations/github/webhook`,
  content_type: "json",
  insecure_ssl: "0",
};
const old = { ...desired, url: "https://paca.howlearnwood.com/api/integrations/github/webhook" };
const health = () => Response.json({ service: "paca-worker-api", environment: "internal" });
const input = { environment: "internal" as const, origin, token: "jwt-fixture", apply: true };

describe("operator GitHub App webhook cutover", () => {
  it("updates only the fixed App configuration after checking the destination and re-reads it", async () => {
    const fetch_ = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(Response.json(old))
      .mockResolvedValueOnce(Response.json({ ...desired, secret: "masked-fixture" }))
      .mockResolvedValueOnce(Response.json(desired));
    const result = await configureGitHubAppWebhook({ ...input, fetch: fetch_ });
    expect(result).toMatchObject({ status: "verified", updated: true });
    expect(JSON.stringify(result)).not.toMatch(/masked-fixture|jwt-fixture/);
    expect(fetch_.mock.calls.map(([url, init]) => [url, init?.method ?? "GET"])).toEqual([
      [`${origin}/health`, "GET"],
      ["https://api.github.com/app/hook/config", "GET"],
      ["https://api.github.com/app/hook/config", "PATCH"],
      ["https://api.github.com/app/hook/config", "GET"],
    ]);
    expect(fetch_.mock.calls[0]?.[1]?.headers).toBeUndefined();
    expect(JSON.parse(String(fetch_.mock.calls[2]?.[1]?.body))).toEqual(desired);
    for (const [, init] of fetch_.mock.calls) expect(init?.redirect).toBe("manual");
  });
  it("inspects without contacting the future environment or mutating the App", async () => {
    const fetch_ = vi.fn<typeof fetch>().mockResolvedValue(Response.json(old));
    expect(
      await configureGitHubAppWebhook({ ...input, apply: false, fetch: fetch_ }),
    ).toMatchObject({ status: "update_required", updated: false });
    expect(fetch_).toHaveBeenCalledOnce();
    expect(fetch_.mock.calls[0]?.[1]?.method).toBe("GET");
  });
  it("does not patch an already-correct configuration", async () => {
    const fetch_ = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(Response.json(desired));
    expect(await configureGitHubAppWebhook({ ...input, fetch: fetch_ })).toMatchObject({
      status: "verified",
      updated: false,
    });
    expect(fetch_).toHaveBeenCalledTimes(2);
  });
  it("refuses a production destination still served by internal", async () => {
    const fetch_ = vi.fn<typeof fetch>().mockResolvedValue(health());
    await expect(
      configureGitHubAppWebhook({
        ...input,
        environment: "production",
        origin: "https://paca.howlearnwood.com",
        fetch: fetch_,
      }),
    ).rejects.toThrow();
    expect(fetch_).toHaveBeenCalledOnce();
  });
  it("rejects foreign origins before sending the App JWT", async () => {
    const fetch_ = vi.fn<typeof fetch>();
    await expect(
      configureGitHubAppWebhook({ ...input, origin: "https://evil.test", fetch: fetch_ }),
    ).rejects.toThrow("GITHUB_APP_ORIGIN_INVALID");
    expect(fetch_).not.toHaveBeenCalled();
  });
  it("refuses redirects and oversized responses", async () => {
    for (const response of [
      new Response(null, { status: 302, headers: { location: "https://evil.test" } }),
      new Response("x".repeat(32769)),
    ]) {
      const fetch_ = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(
        configureGitHubAppWebhook({ ...input, apply: false, fetch: fetch_ }),
      ).rejects.toThrow(/GITHUB_APP_WEBHOOK_(HTTP_FAILED|RESPONSE_TOO_LARGE)/);
      expect(fetch_).toHaveBeenCalledOnce();
    }
  });
  it("does not report success if readback differs after the patch", async () => {
    const fetch_ = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(Response.json(old))
      .mockResolvedValueOnce(Response.json(desired))
      .mockResolvedValueOnce(Response.json(old));
    await expect(configureGitHubAppWebhook({ ...input, fetch: fetch_ })).rejects.toThrow(
      "GITHUB_APP_WEBHOOK_UPDATE_NOT_VERIFIED",
    );
  });
});
