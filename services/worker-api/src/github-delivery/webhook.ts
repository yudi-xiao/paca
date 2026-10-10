import * as z from "zod";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const payloadSchema = z.object({
  action: z.string().max(80).optional(),
  installation: z.object({ id }),
  repository: z.object({ id }).optional(),
  pull_request: z.object({ number: id, head: z.object({ sha }) }).optional(),
  check_run: z.object({ head_sha: sha }).optional(),
  check_suite: z.object({ head_sha: sha }).optional(),
  repositories_removed: z.array(z.object({ id })).max(500).optional(),
});
export type GitHubWebhookEvent = {
  deliveryId: string;
  digest: string;
  event: string;
  installationId: number;
  repositoryId: number | null;
  pullNumber: number | null;
  headSha: string | null;
  revoke: boolean;
  removedRepositoryIds: number[];
};
export class GitHubWebhookError extends Error {
  constructor(
    readonly code:
      | "GITHUB_WEBHOOK_SIGNATURE_INVALID"
      | "GITHUB_WEBHOOK_INPUT_INVALID"
      | "GITHUB_WEBHOOK_TOO_LARGE"
      | "GITHUB_WEBHOOK_NOT_CONFIGURED"
      | "GITHUB_WEBHOOK_IDEMPOTENCY_CONFLICT",
  ) {
    super(code);
  }
}

export async function verifyGitHubWebhook(
  request: Request,
  secret: string | undefined,
): Promise<GitHubWebhookEvent | null> {
  if (!secret || secret.length < 20 || secret.length > 1024)
    throw new GitHubWebhookError("GITHUB_WEBHOOK_NOT_CONFIGURED");
  const signature = request.headers.get("x-hub-signature-256");
  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature))
    throw new GitHubWebhookError("GITHUB_WEBHOOK_SIGNATURE_INVALID");
  const deliveryId = z.uuid().safeParse(request.headers.get("x-github-delivery"));
  const event = request.headers.get("x-github-event");
  if (
    !deliveryId.success ||
    !event ||
    !/^[a-z_]{1,60}$/.test(event) ||
    request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json"
  )
    throw new GitHubWebhookError("GITHUB_WEBHOOK_INPUT_INVALID");
  const reader = request.body?.getReader();
  if (!reader) throw new GitHubWebhookError("GITHUB_WEBHOOK_INPUT_INVALID");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) {
        await reader.cancel().catch(() => undefined);
        throw new GitHubWebhookError("GITHUB_WEBHOOK_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signatureBytes = Uint8Array.from(signature.slice(7).match(/../g) ?? [], (part) =>
    Number.parseInt(part, 16),
  );
  if (!(await crypto.subtle.verify("HMAC", key, signatureBytes, bytes)))
    throw new GitHubWebhookError("GITHUB_WEBHOOK_SIGNATURE_INVALID");
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new GitHubWebhookError("GITHUB_WEBHOOK_INPUT_INVALID");
  }
  if (event === "ping" && raw && typeof raw === "object") return null;
  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) throw new GitHubWebhookError("GITHUB_WEBHOOK_INPUT_INVALID");
  const payload = parsed.data;
  // Payloads only invalidate snapshots. Acceptance always rereads GitHub; even
  // an authentic, duplicated or out-of-order success event cannot approve work.
  let pullNumber: number | null = null;
  let headSha: string | null = null;
  let revoke = false;
  let removedRepositoryIds: number[] = [];
  if (event === "pull_request" || event === "pull_request_review") {
    if (!payload.pull_request || !payload.repository)
      throw new GitHubWebhookError("GITHUB_WEBHOOK_INPUT_INVALID");
    pullNumber = payload.pull_request.number;
  } else if (event === "check_run" || event === "check_suite") {
    const check = event === "check_run" ? payload.check_run : payload.check_suite;
    if (!check || !payload.repository) throw new GitHubWebhookError("GITHUB_WEBHOOK_INPUT_INVALID");
    headSha = check.head_sha;
  } else if (event === "installation") {
    if (!["deleted", "suspend"].includes(payload.action ?? "")) return null;
    revoke = true;
  } else if (event === "installation_repositories") {
    if (payload.action !== "removed") return null;
    removedRepositoryIds = payload.repositories_removed?.map((repository) => repository.id) ?? [];
    if (!removedRepositoryIds.length) throw new GitHubWebhookError("GITHUB_WEBHOOK_INPUT_INVALID");
    revoke = true;
  } else return null;
  const prefix = new TextEncoder().encode(`${event}\0`);
  const digestBytes = new Uint8Array(prefix.length + bytes.length);
  digestBytes.set(prefix);
  digestBytes.set(bytes, prefix.length);
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", digestBytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return {
    deliveryId: deliveryId.data,
    digest,
    event,
    installationId: payload.installation.id,
    repositoryId: payload.repository?.id ?? null,
    pullNumber,
    headSha,
    revoke,
    removedRepositoryIds,
  };
}
