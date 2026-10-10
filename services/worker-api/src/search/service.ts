import { Buffer } from "node:buffer";
import * as z from "zod";

export const searchKinds = ["tasks", "docs"] as const;
export type SearchKind = (typeof searchKinds)[number];
export class ProjectSearchError extends Error {
  constructor(
    readonly code: "SEARCH_INPUT_INVALID" | "SEARCH_CURSOR_INVALID" | "SEARCH_SCOPE_DENIED",
  ) {
    super(code);
    this.name = "ProjectSearchError";
  }
}
const cursorSchema = z
  .object({
    version: z.literal(1),
    projectId: z.uuid(),
    kind: z.enum(searchKinds),
    query: z.string().min(1).max(200),
    id: z.uuid(),
    createdAt: z.iso.datetime(),
  })
  .strict();
const inputSchema = z
  .object({
    projectId: z.uuid(),
    kind: z.enum(searchKinds),
    query: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().max(2048).optional(),
  })
  .strict();
export type ProjectSearchInput = {
  projectId: string;
  kind: SearchKind;
  query: string;
  limit?: number;
  cursor?: string;
};
export type SearchHit = {
  id: string;
  title: string;
  taskNumber: number | null;
  matchedIn: "title" | "content";
  snippet: string;
  createdAt: Date;
  cursorCreatedAt: string;
  updatedAt: Date;
};
export type SearchPage = { items: SearchHit[]; nextCursor: string | null; matching: "literal" };
export type NormalizedSearchInput = {
  projectId: string;
  kind: SearchKind;
  query: string;
  limit: number;
  after: { id: string; createdAt: string } | null;
  allowedIds: readonly string[] | null;
};
export interface ProjectSearchRepository {
  search(input: NormalizedSearchInput): Promise<SearchHit[]>;
}
export class ProjectSearchService {
  constructor(private readonly repository: ProjectSearchRepository) {}
  async search(
    value: ProjectSearchInput,
    allowedIds: readonly string[] | null = null,
  ): Promise<SearchPage> {
    const parsed = inputSchema.safeParse(value);
    if (
      !parsed.success ||
      (allowedIds !== null && !z.array(z.uuid()).max(100).safeParse(allowedIds).success)
    )
      throw new ProjectSearchError("SEARCH_INPUT_INVALID");
    const input = parsed.data;
    let after: NormalizedSearchInput["after"] = null;
    if (input.cursor !== undefined) {
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw Error();
        const cursor = cursorSchema.parse(
          JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")),
        );
        if (
          cursor.projectId !== input.projectId ||
          cursor.kind !== input.kind ||
          cursor.query !== input.query
        )
          throw Error();
        after = { id: cursor.id, createdAt: cursor.createdAt };
      } catch {
        throw new ProjectSearchError("SEARCH_CURSOR_INVALID");
      }
    }
    if (allowedIds !== null && allowedIds.length === 0)
      return { items: [], nextCursor: null, matching: "literal" };
    const rows = await this.repository.search({ ...input, after, allowedIds });
    const items = rows.slice(0, input.limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > input.limit && last
          ? Buffer.from(
              JSON.stringify({
                version: 1,
                projectId: input.projectId,
                kind: input.kind,
                query: input.query,
                id: last.id,
                createdAt: last.cursorCreatedAt,
              }),
            ).toString("base64url")
          : null,
      matching: "literal",
    };
  }
}
