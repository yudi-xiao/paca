import {
  encodeStateVector,
  type Doc as YDoc,
  XmlElement as YXmlElement,
  XmlText as YXmlText,
} from "yjs";
import * as z from "zod";

import { materializeBlockNoteDocument } from "./blocknote-materializer";

const MAX_OPERATION_COUNT = 10;
const MAX_INLINE_COUNT = 500;
const MAX_INLINE_TEXT_LENGTH = 100_000;
const MAX_CONTENT_BYTES = 256_000;
export const DOCUMENT_AGENT_LEASE_MIN_DURATION_MS = 5_000;
export const DOCUMENT_AGENT_LEASE_MAX_DURATION_MS = 60_000;
const textEncoder = new TextEncoder();

const styleSchema = z
  .object({
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strike: z.boolean().optional(),
    code: z.boolean().optional(),
    textColor: z.string().min(1).max(100).optional(),
    backgroundColor: z.string().min(1).max(100).optional(),
  })
  .strict();

const textInlineSchema = z
  .object({
    type: z.literal("text"),
    text: z.string().max(MAX_INLINE_TEXT_LENGTH),
    styles: styleSchema.default({}),
  })
  .strict();

const safeHrefSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine((value) => /^(https?:|mailto:|\/|#)/i.test(value), "DOCUMENT_AGENT_LINK_PROTOCOL_DENIED");

const linkInlineSchema = z
  .object({
    type: z.literal("link"),
    href: safeHrefSchema,
    content: z.array(textInlineSchema).min(1).max(MAX_INLINE_COUNT),
  })
  .strict();

const teamMentionSchema = z
  .object({
    type: z.literal("teamMention"),
    props: z
      .object({
        id: z.string().min(1).max(255),
        name: z.string().min(1).max(500),
        avatar: z.string().max(2_048).optional(),
      })
      .strict(),
  })
  .strict();

const taskReferenceSchema = z
  .object({
    type: z.literal("taskReference"),
    props: z
      .object({
        id: z.string().min(1).max(255),
        title: z.string().min(1).max(500),
        status: z.string().min(1).max(100),
      })
      .strict(),
  })
  .strict();

const docReferenceSchema = z
  .object({
    type: z.literal("docReference"),
    props: z
      .object({
        id: z.string().min(1).max(255),
        title: z.string().min(1).max(500),
      })
      .strict(),
  })
  .strict();

export const documentInlineContentSchema = z.discriminatedUnion("type", [
  textInlineSchema,
  linkInlineSchema,
  teamMentionSchema,
  taskReferenceSchema,
  docReferenceSchema,
]);

const replaceBlockContentSchema = z
  .object({
    type: z.literal("replace_block_content"),
    blockId: z.string().min(1).max(255),
    expectedBlockVersion: z
      .string()
      .min(1)
      .max(400_000)
      .regex(/^[A-Za-z0-9_-]+$/),
    content: z.array(documentInlineContentSchema).max(MAX_INLINE_COUNT),
  })
  .strict()
  .superRefine((value, context) => {
    if (textEncoder.encode(JSON.stringify(value.content)).byteLength > MAX_CONTENT_BYTES) {
      context.addIssue({ code: "custom", message: "DOCUMENT_AGENT_CONTENT_TOO_LARGE" });
    }
  });

export const documentAgentEditInputSchema = z
  .object({
    action: z.literal("apply"),
    requestId: z.uuid(),
    runId: z.uuid(),
    baseRevision: z.number().int().nonnegative().safe(),
    baseStateVector: z
      .string()
      .min(1)
      .max(400_000)
      .regex(/^[A-Za-z0-9_-]+$/),
    operationMode: z.enum(["suggest", "collaborate", "exclusive"]),
    leaseId: z.uuid().optional(),
    operations: z.array(replaceBlockContentSchema).min(1).max(MAX_OPERATION_COUNT),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.operationMode === "exclusive" && !value.leaseId) {
      context.addIssue({
        code: "custom",
        message: "DOCUMENT_AGENT_EXCLUSIVE_LEASE_REQUIRED",
        path: ["leaseId"],
      });
    }
    if (value.operationMode !== "exclusive" && value.leaseId) {
      context.addIssue({
        code: "custom",
        message: "DOCUMENT_AGENT_LEASE_MODE_INVALID",
        path: ["leaseId"],
      });
    }
    const seen = new Set<string>();
    for (const operation of value.operations) {
      if (seen.has(operation.blockId)) {
        context.addIssue({
          code: "custom",
          message: "DOCUMENT_AGENT_DUPLICATE_BLOCK_TARGET",
          path: ["operations"],
        });
      }
      seen.add(operation.blockId);
    }
  });

const documentAgentLeaseBaseSchema = z.object({
  requestId: z.uuid(),
  runId: z.uuid(),
  operationMode: z.literal("exclusive"),
});

const documentAgentAcquireLeaseSchema = documentAgentLeaseBaseSchema
  .extend({
    action: z.literal("acquire_lease"),
    leaseDurationMs: z
      .number()
      .int()
      .min(DOCUMENT_AGENT_LEASE_MIN_DURATION_MS)
      .max(DOCUMENT_AGENT_LEASE_MAX_DURATION_MS),
  })
  .strict();

const documentAgentRenewLeaseSchema = documentAgentLeaseBaseSchema
  .extend({
    action: z.literal("renew_lease"),
    leaseId: z.uuid(),
    leaseDurationMs: z
      .number()
      .int()
      .min(DOCUMENT_AGENT_LEASE_MIN_DURATION_MS)
      .max(DOCUMENT_AGENT_LEASE_MAX_DURATION_MS),
  })
  .strict();

const documentAgentReleaseLeaseSchema = documentAgentLeaseBaseSchema
  .extend({
    action: z.literal("release_lease"),
    leaseId: z.uuid(),
  })
  .strict();

export const documentAgentCommandSchema = z.discriminatedUnion("action", [
  documentAgentEditInputSchema,
  documentAgentAcquireLeaseSchema,
  documentAgentRenewLeaseSchema,
  documentAgentReleaseLeaseSchema,
]);

export type DocumentAgentEditInput = z.infer<typeof documentAgentEditInputSchema>;
export type DocumentAgentOperation = DocumentAgentEditInput["operations"][number];
export type DocumentAgentCommand = z.infer<typeof documentAgentCommandSchema>;

export type VersionedDocumentBlock = {
  blockJson: string;
  blockId: string;
  version: string;
};

export type DocumentAgentSnapshot = {
  documentId: string;
  revision: number;
  stateVector: string;
  blocks: VersionedDocumentBlock[];
};

export type DocumentAgentEditResult = {
  action: "apply";
  applied: boolean;
  conflict: boolean;
  documentId: string;
  requestId: string;
  runId: string;
  mode: "suggest" | "collaborate" | "exclusive";
  baseRevision: number;
  revision: number;
  stateVector: string;
  targets: Array<{ blockId: string; version: string }>;
};

export type DocumentAgentLeaseResult = {
  action: "acquire_lease" | "release_lease" | "renew_lease";
  acquired: boolean;
  conflict: boolean;
  documentId: string;
  expiresAt: number | null;
  leaseId: string | null;
  released: boolean;
  requestId: string;
  revision: number;
  runId: string;
};

export type DocumentAgentCommandResult = DocumentAgentEditResult | DocumentAgentLeaseResult;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function stringVersion(value: unknown): string {
  return bytesToBase64Url(textEncoder.encode(JSON.stringify(value)));
}

function blockScope(block: Record<string, unknown>): Record<string, unknown> {
  return {
    id: block.id,
    type: block.type,
    props: block.props,
    content: block.content,
  };
}

function versionedBlocks(document: YDoc): VersionedDocumentBlock[] {
  return materializeBlockNoteDocument(document).map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("DOCUMENT_AGENT_BLOCK_INVALID");
    }
    const block = value as Record<string, unknown>;
    if (typeof block.id !== "string") throw new Error("DOCUMENT_AGENT_BLOCK_INVALID");
    return {
      blockJson: JSON.stringify(block),
      blockId: block.id,
      version: stringVersion(blockScope(block)),
    };
  });
}

export function inspectDocumentForAgent(
  document: YDoc,
  documentId: string,
  revision: number,
): DocumentAgentSnapshot {
  return {
    documentId,
    revision,
    stateVector: bytesToBase64Url(encodeStateVector(document)),
    blocks: versionedBlocks(document),
  };
}

export function evaluateDocumentAgentEdit(
  snapshot: DocumentAgentSnapshot,
  input: DocumentAgentEditInput,
): { conflicts: Array<{ blockId: string; version: string | null }> } {
  if (input.baseRevision > snapshot.revision) {
    throw new Error("DOCUMENT_AGENT_BASE_REVISION_INVALID");
  }
  if (input.baseRevision === snapshot.revision && input.baseStateVector !== snapshot.stateVector) {
    throw new Error("DOCUMENT_AGENT_STATE_VECTOR_MISMATCH");
  }
  const versions = new Map(snapshot.blocks.map((entry) => [entry.blockId, entry.version]));
  const conflicts = input.operations.flatMap((operation) => {
    const current = versions.get(operation.blockId) ?? null;
    return current === operation.expectedBlockVersion
      ? []
      : [{ blockId: operation.blockId, version: current }];
  });
  return { conflicts };
}

function findBlockContainer(group: YXmlElement, blockId: string): YXmlElement | null {
  for (const child of group.toArray()) {
    if (!(child instanceof YXmlElement) || child.nodeName !== "blockContainer") continue;
    if (child.getAttribute("id") === blockId) return child;
    const nested = child
      .toArray()
      .find(
        (candidate): candidate is YXmlElement =>
          candidate instanceof YXmlElement && candidate.nodeName === "blockGroup",
      );
    const match = nested ? findBlockContainer(nested, blockId) : null;
    if (match) return match;
  }
  return null;
}

function contentElement(document: YDoc, blockId: string): YXmlElement {
  const root = document.getXmlFragment("document-store").toArray();
  if (root.length !== 1 || !(root[0] instanceof YXmlElement) || root[0].nodeName !== "blockGroup") {
    throw new Error("DOCUMENT_AGENT_ROOT_INVALID");
  }
  const container = findBlockContainer(root[0], blockId);
  if (!container) throw new Error("DOCUMENT_AGENT_BLOCK_NOT_FOUND");
  const content = container
    .toArray()
    .find(
      (candidate): candidate is YXmlElement =>
        candidate instanceof YXmlElement && candidate.nodeName !== "blockGroup",
    );
  if (!content) throw new Error("DOCUMENT_AGENT_BLOCK_CONTENT_MISSING");
  if (content.nodeName === "table") throw new Error("DOCUMENT_AGENT_TABLE_EDIT_UNSUPPORTED");
  return content;
}

function styleMarks(styles: z.infer<typeof styleSchema>): Record<string, unknown> {
  const marks: Record<string, unknown> = {};
  for (const name of ["bold", "italic", "underline", "strike", "code"] as const) {
    if (styles[name]) marks[name] = {};
  }
  if (styles.textColor) marks.textColor = { stringValue: styles.textColor };
  if (styles.backgroundColor) marks.backgroundColor = { stringValue: styles.backgroundColor };
  return marks;
}

function appendText(
  destination: YXmlElement,
  value: z.infer<typeof textInlineSchema>,
  link?: { href: string },
): void {
  if (!value.text) return;
  const text = new YXmlText();
  text.insert(0, value.text, { ...styleMarks(value.styles), ...(link ? { link } : {}) });
  destination.insert(destination.length, [text]);
}

function appendInline(
  destination: YXmlElement,
  value: z.infer<typeof documentInlineContentSchema>,
): void {
  if (value.type === "text") {
    appendText(destination, value);
    return;
  }
  if (value.type === "link") {
    for (const child of value.content) appendText(destination, child, { href: value.href });
    return;
  }
  const element = new YXmlElement(value.type);
  for (const [name, prop] of Object.entries(value.props)) {
    if (prop !== undefined) element.setAttribute(name, prop);
  }
  destination.insert(destination.length, [element]);
}

export function applyDocumentAgentOperations(
  document: YDoc,
  operations: DocumentAgentOperation[],
): void {
  for (const operation of operations) {
    const content = contentElement(document, operation.blockId);
    if (content.length > 0) content.delete(0, content.length);
    for (const inline of operation.content) appendInline(content, inline);
  }
}
