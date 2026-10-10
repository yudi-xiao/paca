import { describe, expect, it, vi } from "vitest";
import {
  type ProductionProbeBindings,
  runProductionProbe,
} from "../scripts/lib/production-probe-worker";

function fixtures() {
  const bucket = () => ({
    put: vi.fn(async () => undefined),
    get: vi.fn(async () => ({ text: async () => "paca-production-probe" })),
    delete: vi.fn(async () => undefined),
    head: vi.fn(async () => null),
  });
  const env = {
    PROBE_TOKEN: "a".repeat(96),
    API_HEALTH_TOKEN: "b".repeat(96),
    PROBE_NAMESPACE: "c".repeat(64),
    API: {
      fetch: vi.fn(async (request: Request) => {
        switch (new URL(request.url).pathname) {
          case "/health":
            return Response.json({ service: "paca-worker-api", environment: "prod" });
          case "/internal/health/database":
            return Response.json({
              status: "ok",
              connection: "hyperdrive",
              privateDiagnostic: "never-return-this",
            });
          case "/api/me":
            return new Response(null, { status: 401 });
          default:
            return new Response("<html></html>");
        }
      }),
    },
    GATEWAY: { fetch: vi.fn(async () => Response.json({ environment: "prod" })) },
    ATTACHMENTS: bucket(),
    SNAPSHOTS: bucket(),
  } satisfies ProductionProbeBindings;
  const request = (init?: RequestInit) =>
    new Request("https://probe.workers.dev/verify", {
      method: "POST",
      headers: { authorization: `Bearer ${env.PROBE_TOKEN}` },
      ...init,
    });
  return { env, request };
}

describe("temporary production operator boundary", () => {
  it("requires the operator bearer before any remote access", async () => {
    const { env, request } = fixtures();
    for (const bearer of ["", "Bearer wrong", "a".repeat(1025)])
      expect(
        (await runProductionProbe(request({ headers: { authorization: bearer } }), env)).status,
      ).toBe(401);
    expect(env.API.fetch).not.toHaveBeenCalled();
    expect(env.ATTACHMENTS.put).not.toHaveBeenCalled();
  });
  it("rejects browser origins, bodies, alternative methods and query/forwarding destinations", async () => {
    const { env, request } = fixtures();
    for (const req of [
      request({ method: "GET" }),
      request({ headers: { origin: "https://evil.test" } }),
      request({ body: "untrusted" }),
      new Request("https://probe.workers.dev/verify?url=https://evil.test", { method: "POST" }),
    ])
      expect((await runProductionProbe(req, env)).status).toBe(404);
    expect(env.API.fetch).not.toHaveBeenCalled();
  });
  it("verifies exact fixed targets, avoids forwarding caller cookies and deletes both fixture objects", async () => {
    const { env, request } = fixtures();
    const response = await runProductionProbe(
      request({ headers: { authorization: `Bearer ${env.PROBE_TOKEN}`, cookie: "caller-cookie" } }),
      env,
    );
    expect(response.status).toBe(200);
    const output = await response.text();
    expect(output).not.toContain("never-return-this");
    expect(output).not.toContain(env.PROBE_TOKEN);
    expect(output).not.toContain(env.API_HEALTH_TOKEN);
    const calls = env.API.fetch.mock.calls.map(([req]) => req);
    expect(calls.map((req) => req.url)).toEqual([
      "https://paca.howlearnwood.com/health",
      "https://paca.howlearnwood.com/internal/health/database",
      "https://paca.howlearnwood.com/api/me",
      "https://paca.howlearnwood.com/",
    ]);
    for (const req of calls) expect(req.headers.has("cookie")).toBe(false);
    expect(calls[1]?.headers.get("authorization")).toBe(`Bearer ${env.API_HEALTH_TOKEN}`);
    for (const b of [env.ATTACHMENTS, env.SNAPSHOTS])
      expect(b.delete).toHaveBeenCalledWith(`release-probe/${env.PROBE_NAMESPACE}`);
  });
  it("rejects the wrong environment before checking private database health or writing fixtures", async () => {
    const { env, request } = fixtures();
    env.API.fetch.mockResolvedValueOnce(
      Response.json({ service: "paca-worker-api", environment: "internal" }),
    );
    const response = await runProductionProbe(request(), env);
    expect(await response.json()).toMatchObject({ status: "failed", code: "API_HEALTH_FAILED" });
    expect(env.API.fetch).toHaveBeenCalledOnce();
    expect(env.ATTACHMENTS.put).not.toHaveBeenCalled();
  });
  it("cleans the scoped R2 fixture if readback fails", async () => {
    const { env, request } = fixtures();
    env.ATTACHMENTS.get.mockResolvedValueOnce({ text: async () => "wrong" });
    const response = await runProductionProbe(request(), env);
    expect(await response.json()).toMatchObject({ status: "failed", code: "R2_READBACK_FAILED" });
    expect(env.ATTACHMENTS.delete).toHaveBeenCalledOnce();
    expect(env.SNAPSHOTS.put).not.toHaveBeenCalled();
  });
  it("does not expose provider errors or report a failed deletion as a pass", async () => {
    const { env, request } = fixtures();
    env.ATTACHMENTS.delete.mockRejectedValueOnce(Error("provider private error"));
    const response = await runProductionProbe(request(), env);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("provider private error");
  });
});
