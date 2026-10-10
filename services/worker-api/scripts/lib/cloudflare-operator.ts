import * as z from "zod";
import { operatorJson } from "./operator-command";

export const PACA_CLOUDFLARE_ACCOUNT = "25f556b8c06e910fb3115a6c47c25bf9";

export async function cloudflareOperator() {
  const auth = z
    .object({ type: z.enum(["oauth", "api_token"]), token: z.string().min(1) })
    .parse(
      await operatorJson("bun", [
        "node_modules/wrangler/bin/wrangler.js",
        "auth",
        "token",
        "--json",
        "--profile",
        "paca",
      ]),
    );
  return async (path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<unknown> => {
    if (!/^\/[a-z0-9_/-]+$/u.test(path)) throw new Error("CLOUDFLARE_OPERATOR_PATH_INVALID");
    try {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${PACA_CLOUDFLARE_ACCOUNT}${path}`,
        {
          method,
          headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        },
      );
      const result = z
        .object({ success: z.literal(true), result: z.unknown() })
        .safeParse(await response.json());
      if (!response.ok || !result.success) throw new Error("CLOUDFLARE_OPERATOR_REQUEST_FAILED");
      return result.data.result;
    } catch {
      throw new Error("CLOUDFLARE_OPERATOR_REQUEST_FAILED");
    }
  };
}

export async function deployedHyperdriveConsumers(
  request: Awaited<ReturnType<typeof cloudflareOperator>>,
  hyperdriveIds: string[],
): Promise<{ worker: string; hyperdriveId: string }[]> {
  const workers = z
    .array(z.object({ id: z.string().regex(/^[a-z0-9_-]+$/u) }))
    .parse(await request("/workers/scripts"));
  const consumers: { worker: string; hyperdriveId: string }[] = [];
  // Inspect all account Workers, including non-Paca consumers, before retiring
  // a shared resource. A failure is not evidence that the resource is unused.
  for (const worker of workers) {
    const settings = z
      .object({ bindings: z.array(z.object({ type: z.string(), id: z.string().optional() })) })
      .parse(await request(`/workers/scripts/${worker.id}/settings`));
    for (const binding of settings.bindings) {
      if (binding.type === "hyperdrive" && binding.id && hyperdriveIds.includes(binding.id)) {
        consumers.push({ worker: worker.id, hyperdriveId: binding.id });
      }
    }
  }
  return consumers;
}
