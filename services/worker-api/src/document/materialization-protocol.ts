import { z } from "zod";

const documentMaterializationMessageSchema = z
  .object({
    kind: z.literal("document.materialize"),
    version: z.literal(1),
    documentId: z.string().uuid(),
    revision: z.number().int().positive().safe(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type DocumentMaterializationMessage = z.infer<typeof documentMaterializationMessageSchema>;

export function parseDocumentMaterializationMessage(
  value: unknown,
): DocumentMaterializationMessage {
  return documentMaterializationMessageSchema.parse(value);
}
