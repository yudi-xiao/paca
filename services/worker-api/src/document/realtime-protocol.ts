import * as z from "zod";

export const DOCUMENT_CONTEXT_HEADER = "x-paca-document-context";
export const DOCUMENT_CONNECTION_TTL_MS = 5 * 60_000;

const documentConnectionStateSchema = z
  .object({
    version: z.literal(1),
    actorType: z.enum(["user", "agent"]),
    actorId: z.string().min(1).max(255),
    sessionId: z.string().min(1).max(255).nullable(),
    organizationId: z.string().min(1).max(255),
    projectId: z.uuid(),
    documentId: z.uuid(),
    canWrite: z.boolean(),
    issuedAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    nonce: z.uuid(),
    permissionVersion: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((state, context) => {
    if (state.actorType === "user" && !state.sessionId) {
      context.addIssue({ code: "custom", message: "User connection requires sessionId" });
    }
    if (state.actorType === "agent") {
      if (state.sessionId) {
        context.addIssue({ code: "custom", message: "Agent connection cannot use sessionId" });
      }
      if (state.canWrite) {
        context.addIssue({
          code: "custom",
          message: "Agent Yjs connections are read-only; edits use structured operations",
        });
      }
    }
    if (state.issuedAt >= state.expiresAt) {
      context.addIssue({ code: "custom", message: "Connection lifetime is invalid" });
    }
  });

export type DocumentConnectionState = z.infer<typeof documentConnectionStateSchema>;

export function parseDocumentConnectionState(value: unknown): DocumentConnectionState | null {
  const parsed = documentConnectionStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function encodeDocumentConnectionState(state: DocumentConnectionState): string {
  const encoded = encodeURIComponent(JSON.stringify(documentConnectionStateSchema.parse(state)));
  if (new TextEncoder().encode(encoded).byteLength > 1_800) {
    throw new Error("DOCUMENT_CONNECTION_CONTEXT_TOO_LARGE");
  }
  return encoded;
}

export function decodeDocumentConnectionState(
  value: string | null,
): DocumentConnectionState | null {
  if (!value) return null;
  try {
    return parseDocumentConnectionState(JSON.parse(decodeURIComponent(value)));
  } catch {
    return null;
  }
}

export async function documentPermissionVersion(
  state: Pick<
    DocumentConnectionState,
    | "actorType"
    | "actorId"
    | "sessionId"
    | "organizationId"
    | "projectId"
    | "documentId"
    | "canWrite"
  >,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(state)),
  );
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
