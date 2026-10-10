type ProbeFetcher = { fetch(request: Request): Promise<Response> };
type ProbeBucket = {
  put(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  delete(key: string): Promise<unknown>;
  head(key: string): Promise<unknown | null>;
};
export type ProductionProbeBindings = {
  API: ProbeFetcher;
  GATEWAY: ProbeFetcher;
  ATTACHMENTS: ProbeBucket;
  SNAPSHOTS: ProbeBucket;
  PROBE_TOKEN: string;
  API_HEALTH_TOKEN: string;
  PROBE_NAMESPACE: string;
};

/** Temporary operator entry point, never bundled into the Paca API. All
 * destinations and operations are fixed; caller headers/cookies/body are
 * never forwarded. R2 writes use only this invocation's isolated fixture key. */
export async function runProductionProbe(request: Request, env: ProductionProbeBindings) {
  const url = new URL(request.url);
  const headers = { "cache-control": "no-store" };
  if (
    request.method !== "POST" ||
    url.pathname !== "/verify" ||
    url.search ||
    request.headers.has("origin")
  )
    return new Response(null, { status: 404, headers });
  if (
    !/^[a-f0-9]{96}$/u.test(env.PROBE_TOKEN) ||
    !/^[a-f0-9]{96}$/u.test(env.API_HEALTH_TOKEN) ||
    !/^[a-f0-9]{64}$/u.test(env.PROBE_NAMESPACE)
  )
    return new Response(null, { status: 503, headers });
  const bearer = request.headers.get("authorization") ?? "";
  if (bearer.length > 1024) return new Response(null, { status: 401, headers });
  const digest = async (value: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const actual = await digest(bearer);
  const expected = await digest(`Bearer ${env.PROBE_TOKEN}`);
  let difference = 0;
  for (let index = 0; index < actual.length; index++)
    difference |= (actual[index] ?? 0) ^ (expected[index] ?? 0);
  if (difference !== 0) return new Response(null, { status: 401, headers });
  if (request.body) {
    const reader = request.body.getReader();
    try {
      const chunk = await reader.read();
      if (!chunk.done && chunk.value.byteLength !== 0)
        return new Response(null, { status: 404, headers });
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }
  const results: Record<string, string | number> = {};
  const failures = new Set([
    "API_HEALTH_FAILED",
    "GATEWAY_HEALTH_FAILED",
    "DATABASE_HEALTH_FAILED",
    "ANONYMOUS_BOUNDARY_FAILED",
    "ASSETS_FAILED",
    "R2_READBACK_FAILED",
    "R2_CLEANUP_FAILED",
  ]);
  try {
    const api = await env.API.fetch(new Request("https://paca.howlearnwood.com/health"));
    const health = await api.json<{ service?: string; environment?: string }>();
    if (api.status !== 200 || health.service !== "paca-worker-api" || health.environment !== "prod")
      throw Error("API_HEALTH_FAILED");
    results.apiHealth = "verified";
    const gateway = await env.GATEWAY.fetch(
      new Request("https://paca-env.howlearnwood.com/health"),
    );
    const gatewayHealth = await gateway.json<{ environment?: string }>();
    if (gateway.status !== 200 || gatewayHealth.environment !== "prod")
      throw Error("GATEWAY_HEALTH_FAILED");
    results.gatewayHealth = "verified";
    const database = await env.API.fetch(
      new Request("https://paca.howlearnwood.com/internal/health/database", {
        headers: { authorization: `Bearer ${env.API_HEALTH_TOKEN}` },
      }),
    );
    const databaseHealth = await database.json<{ status?: string; connection?: string }>();
    if (
      database.status !== 200 ||
      databaseHealth.status !== "ok" ||
      databaseHealth.connection !== "hyperdrive"
    )
      throw Error("DATABASE_HEALTH_FAILED");
    results.databaseHealth = "verified";
    const me = await env.API.fetch(new Request("https://paca.howlearnwood.com/api/me"));
    await me.body?.cancel();
    if (me.status !== 401) throw Error("ANONYMOUS_BOUNDARY_FAILED");
    results.anonymousMe = 401;
    const assets = await env.API.fetch(new Request("https://paca.howlearnwood.com/"));
    if (assets.status !== 200 || !(await assets.text()).includes("<html"))
      throw Error("ASSETS_FAILED");
    results.assets = "verified";
    const key = `release-probe/${env.PROBE_NAMESPACE}`;
    for (const bucket of [env.ATTACHMENTS, env.SNAPSHOTS]) {
      try {
        await bucket.put(key, "paca-production-probe");
        const object = await bucket.get(key);
        if (!object || (await object.text()) !== "paca-production-probe")
          throw Error("R2_READBACK_FAILED");
      } finally {
        await bucket.delete(key);
      }
      if (await bucket.head(key)) throw Error("R2_CLEANUP_FAILED");
    }
    results.r2 = "write_read_delete_verified";
    return Response.json({ status: "ok", ...results }, { headers });
  } catch (error) {
    const code =
      error instanceof Error && failures.has(error.message)
        ? error.message
        : "CANDIDATE_PROBE_FAILED";
    return Response.json({ status: "failed", code, ...results }, { status: 503, headers });
  }
}

export default { fetch: runProductionProbe };
