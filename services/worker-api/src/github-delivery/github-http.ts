import { GitHubDeliveryError, type GitHubFailureDiagnostic } from "./evidence";

function operation(path: string): GitHubFailureDiagnostic["operation"] {
  if (/^\/app\/installations\/[0-9]+\/access_tokens$/.test(path)) return "token";
  if (/^\/repos\/[^/]+\/[^/]+\/installation$/.test(path)) return "installation";
  if (/^\/repos\/[^/]+\/[^/]+\/pulls\/[0-9]+$/.test(path)) return "pull";
  if (/^\/repos\/[^/]+\/[^/]+\/commits\/[a-f0-9]{40}\/check-runs\?/.test(path)) return "checks";
  if (/^\/repos\/[^/]+\/[^/]+\/pulls\/[0-9]+\/reviews\?/.test(path)) return "reviews";
  if (/^\/users?\/[^/]+$/.test(path)) return "user";
  if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) return "repository";
  return "other";
}

/** Internal adapter primitive; callers construct paths from validated IDs and
 * repository identifiers. Never pass URLs from GitHub response payloads. */
export async function githubJson(
  path: string,
  token: string | undefined,
  signal: AbortSignal,
  fetch_: typeof fetch = globalThis.fetch,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const op = operation(path);
  const started = performance.now();
  let received = false;
  try {
    const response = await fetch_(`https://api.github.com${path}`, {
      method: body ? "POST" : "GET",
      // Workers rejects redirect:"error" at Request construction. Manual
      // mode plus the non-2xx guard below refuses every redirect before any
      // credential could be forwarded to a different target.
      redirect: "manual",
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
    received = true;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new GitHubDeliveryError("GITHUB_DELIVERY_UNAVAILABLE", {
        operation: op,
        failure: "http",
        httpStatus: response.status,
      });
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
          throw new GitHubDeliveryError("GITHUB_DELIVERY_TOO_LARGE", {
            operation: op,
            failure: "too_large",
          });
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
    throw new GitHubDeliveryError("GITHUB_DELIVERY_UNAVAILABLE", {
      operation: op,
      failure: received ? "response" : "transport",
      transportKind:
        error instanceof Error
          ? error.name === "AbortError"
            ? "aborted"
            : error.name === "TimeoutError"
              ? "timeout"
              : error.name === "TypeError"
                ? "invalid_request"
                : "other"
          : "other",
      elapsedMs: Math.min(20000, Math.max(0, Math.round(performance.now() - started))),
    });
  }
}
