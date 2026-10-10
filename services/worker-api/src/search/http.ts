import { type Context, Hono } from "hono";
import * as z from "zod";
import { type ReadAgentSession, requireAgentAuthentication } from "../agent-auth/http";
import type { AppBindings, AppVariables } from "../bindings";
import { type AuthorizeProjectPermission, requireProjectPermission } from "../permission/http";
import type { ProjectSearchRuntime } from "./runtime";
import { ProjectSearchError, type SearchKind, searchKinds } from "./service";

type SearchContext = Context<{ Bindings: AppBindings; Variables: AppVariables }>;
const requestSchema = z
  .object({
    query: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(50).optional(),
    cursor: z.string().max(2048).optional(),
  })
  .strict();
function errorResponse(context: SearchContext, error: unknown) {
  if (!(error instanceof ProjectSearchError)) throw error;
  return context.json(
    {
      success: false as const,
      error_code: error.code,
      error: error.code,
      request_id: context.get("requestId"),
    },
    error.code === "SEARCH_SCOPE_DENIED" ? 403 : 400,
  );
}
async function readJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new ProjectSearchError("SEARCH_INPUT_INVALID");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) {
        await reader.cancel().catch(() => undefined);
        throw new ProjectSearchError("SEARCH_INPUT_INVALID");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof ProjectSearchError) throw error;
    throw new ProjectSearchError("SEARCH_INPUT_INVALID");
  } finally {
    reader.releaseLock();
  }
}
function pageResponse(page: Awaited<ReturnType<ProjectSearchRuntime["user"]>>) {
  return {
    items: page.items.map((item) => ({
      id: item.id,
      title: item.title,
      task_number: item.taskNumber,
      matched_in: item.matchedIn,
      snippet: item.snippet,
      created_at: item.createdAt.toISOString(),
      updated_at: item.updatedAt.toISOString(),
    })),
    next_cursor: page.nextCursor,
    matching: page.matching,
  };
}
export function createProjectSearchRoutes(
  runtime: ProjectSearchRuntime,
  authorize: AuthorizeProjectPermission,
  readAgent: ReadAgentSession,
) {
  const app = new Hono<{ Bindings: AppBindings; Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.header("cache-control", "no-store");
    await next();
  });
  for (const kind of searchKinds) {
    app.get(
      `/api/v1/projects/:projectId/search/${kind}`,
      requireProjectPermission(
        authorize,
        kind === "tasks" ? { tasks: ["read"] } : { docs: ["read"] },
      ),
      async (context) => {
        try {
          const value = requestSchema.safeParse({
            query: context.req.query("q"),
            ...(context.req.query("limit") !== undefined
              ? { limit: Number(context.req.query("limit")) }
              : {}),
            ...(context.req.query("cursor") !== undefined
              ? { cursor: context.req.query("cursor") }
              : {}),
          });
          if (!value.success) throw new ProjectSearchError("SEARCH_INPUT_INVALID");
          if (!z.uuid().safeParse(context.req.param("projectId")).success)
            throw new ProjectSearchError("SEARCH_INPUT_INVALID");
          const page = await runtime.user(context.env, {
            ...value.data,
            projectId: context.req.param("projectId"),
            kind,
          });
          return context.json({
            success: true as const,
            data: pageResponse(page),
            request_id: context.get("requestId"),
          });
        } catch (error) {
          return errorResponse(context, error);
        }
      },
    );
    app.post(
      `/api/v1/agent/projects/:projectId/search/${kind}`,
      requireAgentAuthentication(readAgent),
      async (context) => {
        try {
          const value = requestSchema.safeParse(await readJson(context.req.raw));
          if (!value.success) throw new ProjectSearchError("SEARCH_INPUT_INVALID");
          if (!z.uuid().safeParse(context.req.param("projectId")).success)
            throw new ProjectSearchError("SEARCH_INPUT_INVALID");
          const page = await runtime.agent(context.env, context.get("agentSession"), {
            ...value.data,
            projectId: context.req.param("projectId"),
            kind: kind as SearchKind,
          });
          return context.json({
            success: true as const,
            data: pageResponse(page),
            request_id: context.get("requestId"),
          });
        } catch (error) {
          return errorResponse(context, error);
        }
      },
    );
  }
  return app;
}
