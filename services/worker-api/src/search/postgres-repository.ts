import { and, desc, eq, ilike, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { PacaDatabase } from "../database";
import { pacaDocuments, pacaProjects, pacaTasks } from "../db/schema";
import type { NormalizedSearchInput, ProjectSearchRepository, SearchHit } from "./service";

export class PostgresProjectSearchRepository implements ProjectSearchRepository {
  constructor(private readonly database: PacaDatabase) {}
  async search(input: NormalizedSearchInput): Promise<SearchHit[]> {
    if (input.allowedIds?.length === 0) return [];
    const table = input.kind === "tasks" ? pacaTasks : pacaDocuments;
    const content = table.searchBody;
    const filters = [
      eq(table.projectId, input.projectId),
      isNull(table.deletedAt),
      eq(pacaProjects.status, "active"),
    ];
    if (input.allowedIds !== null) filters.push(inArray(table.id, [...input.allowedIds]));
    if (input.after)
      filters.push(
        or(
          sql`${table.createdAt} < ${input.after.createdAt}::timestamptz`,
          and(
            sql`${table.createdAt} = ${input.after.createdAt}::timestamptz`,
            lt(table.id, input.after.id),
          ),
        ) ?? sql`false`,
      );
    const candidates = this.database.$with("search_candidates").as(
      this.database
        .select({
          id: table.id,
          title: table.title,
          createdAt: table.createdAt,
          // Keep PostgreSQL microseconds in the cursor; JS Date truncates them.
          cursorCreatedAt:
            sql<string>`to_char(${table.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
              "cursor_created_at",
            ),
          updatedAt: table.updatedAt,
          taskNumber:
            input.kind === "tasks"
              ? pacaTasks.taskNumber
              : sql<number | null>`null::integer`.as("task_number"),
          body: content,
        })
        .from(table)
        .innerJoin(pacaProjects, eq(table.projectId, pacaProjects.id))
        .where(and(...filters)),
    );
    const pattern = `%${input.query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const titleMatch =
      or(
        ilike(candidates.title, pattern),
        /^#\d+$/u.test(input.query)
          ? sql`${candidates.taskNumber}::numeric = ${input.query.slice(1)}::numeric`
          : sql`false`,
      ) ?? sql`false`;
    return this.database
      .with(candidates)
      .select({
        id: candidates.id,
        title: candidates.title,
        taskNumber: candidates.taskNumber,
        createdAt: candidates.createdAt,
        cursorCreatedAt: candidates.cursorCreatedAt,
        updatedAt: candidates.updatedAt,
        matchedIn: sql<
          "title" | "content"
        >`case when ${titleMatch} then 'title' else 'content' end`,
        snippet: sql<string>`substring(${candidates.body} from greatest(1,strpos(lower(${candidates.body}),lower(${input.query}))-80) for 240)`,
      })
      .from(candidates)
      .where(or(titleMatch, ilike(candidates.body, pattern)))
      .orderBy(desc(candidates.createdAt), desc(candidates.id))
      .limit(input.limit + 1);
  }
}
