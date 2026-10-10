import { GitHubDeliveryError } from "./evidence";

/** Internal adapter primitive; callers construct paths from validated IDs and
 * repository identifiers. Never pass URLs from GitHub response payloads. */
export async function githubJson(
  path: string,
  token: string | undefined,
  signal: AbortSignal,
  fetch_: typeof fetch = globalThis.fetch,
  body?: Record<string, unknown>,
): Promise<unknown> {
  try {
    const response = await fetch_(`https://api.github.com${path}`, {
      method: body ? "POST" : "GET",
      redirect: "error",
      signal,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2026-03-10",
        "user-agent": "Paca-GitHub-Delivery",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new GitHubDeliveryError("GITHUB_DELIVERY_UNAVAILABLE");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new GitHubDeliveryError("GITHUB_DELIVERY_UNAVAILABLE");
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) {
          await reader.cancel().catch(() => undefined);
          throw new GitHubDeliveryError("GITHUB_DELIVERY_TOO_LARGE");
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        (_key: string, value: unknown, context?: { source?: string }) => {
          // GitHub webhook delivery IDs are now 64-bit integers. Preserve the
          // original digits; rounding and then interpolating a URL addresses
          // the wrong delivery. Domain adapters still reject unsafe numeric IDs.
          if (
            typeof value === "number" &&
            Number.isInteger(value) &&
            !Number.isSafeInteger(value)
          ) {
            if (!context?.source || !/^-?[0-9]+$/.test(context.source))
              throw new GitHubDeliveryError("GITHUB_DELIVERY_UNAVAILABLE");
            return context.source;
          }
          return value;
        },
      ) as unknown;
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    if (error instanceof GitHubDeliveryError) throw error;
    throw new GitHubDeliveryError("GITHUB_DELIVERY_UNAVAILABLE");
  }
}
