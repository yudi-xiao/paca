import { type Context, Hono } from "hono";
import * as z from "zod";

import type { AppBindings, AppVariables } from "../bindings";
import { type AuthorizeProjectPermission, requireProjectPermission } from "../permission/http";
import { AutomationExecutionError } from "./errors";
import { AutomationGraphError, automationGraphErrorCodes } from "./graph";
import {
  type AutomationEdgeRow,
  type AutomationNodeRow,
  AutomationRepositoryError,
  type AutomationRow,
  type AutomationRunRow,
  type AutomationRunStepRow,
  automationRepositoryErrorCodes,
} from "./postgres-repository";
import type { AutomationRuntime } from "./runtime";

type AutomationContext = Context<{ Bindings: AppBindings; Variables: AppVariables }>;

const createSchema = z.object({ name: z.string(), description: z.string().optional() }).strict();
const updateSchema = z
  .object({ name: z.string().optional(), description: z.string().optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
const nodeCreateSchema = z
  .object({
    kind: z.string(),
    type: z.string(),
    config: z.record(z.string(), z.unknown()),
    pos_x: z.number(),
    pos_y: z.number(),
  })
  .strict();
const nodeUpdateSchema = z
  .object({
    config: z.record(z.string(), z.unknown()).optional(),
    pos_x: z.number().optional(),
    pos_y: z.number().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
const edgeCreateSchema = z
  .object({
    source_node_id: z.uuid(),
    source_handle: z.string().nullable().optional(),
    target_node_id: z.uuid(),
  })
  .strict();

function success<T>(context: AutomationContext, data: T) {
  return context.json({ success: true as const, data, request_id: context.get("requestId") });
}

function failure(context: AutomationContext, status: 400 | 404 | 409 | 413, code: string) {
  return context.json(
    {
      success: false as const,
      error_code: code,
      error: code,
      request_id: context.get("requestId"),
    },
    status,
  );
}

function automationFailure(context: AutomationContext, error: unknown) {
  if (error instanceof AutomationRepositoryError) {
    const status =
      error.code === automationRepositoryErrorCodes.nameTaken ||
      error.code === automationRepositoryErrorCodes.activeImmutable
        ? 409
        : 404;
    return failure(context, status, error.code);
  }
  if (error instanceof AutomationGraphError) {
    const status = error.code === automationGraphErrorCodes.edgeDuplicate ? 409 : 400;
    return failure(context, status, error.code);
  }
  if (error instanceof AutomationExecutionError) {
    return failure(context, 400, error.code);
  }
  throw error;
}

async function readBoundedJson(context: AutomationContext): Promise<unknown | "BODY_TOO_LARGE"> {
  const body = context.req.raw.body;
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 96 * 1024) {
        await reader.cancel();
        return "BODY_TOO_LARGE";
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
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

function automationResponse(row: AutomationRow) {
  return {
    id: row.id,
    project_id: row.projectId,
    name: row.name,
    description: row.description,
    status: row.status,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function nodeResponse(row: AutomationNodeRow) {
  return {
    id: row.id,
    automation_id: row.automationId,
    kind: row.kind,
    type: row.type,
    config: row.config,
    pos_x: row.posX,
    pos_y: row.posY,
  };
}

function edgeResponse(row: AutomationEdgeRow) {
  return {
    id: row.id,
    automation_id: row.automationId,
    source_node_id: row.sourceNodeId,
    source_handle: row.sourceHandle,
    target_node_id: row.targetNodeId,
  };
}

function runResponse(row: AutomationRunRow) {
  return {
    id: row.id,
    automation_id: row.automationId,
    trigger_node_id: row.triggerNodeId,
    task_id: row.taskId,
    status: row.status,
    started_at: row.startedAt.toISOString(),
    finished_at: row.finishedAt?.toISOString() ?? null,
  };
}

function runStepResponse(row: AutomationRunStepRow) {
  return {
    id: row.id,
    run_id: row.runId,
    node_id: row.nodeId,
    status: row.status,
    input_snapshot: row.inputSnapshot,
    output_snapshot: row.outputSnapshot,
    error: row.errorCode ?? undefined,
    executed_at: row.executedAt.toISOString(),
  };
}

function validIds(context: AutomationContext, ...names: string[]): boolean {
  return names.every((name) => z.uuid().safeParse(context.req.param(name)).success);
}

function projectId(context: AutomationContext): string {
  const value = context.req.param("projectId");
  if (!value) throw new Error("AUTOMATION_PROJECT_ROUTE_MISSING");
  return value;
}

/** Project-scoped graph API; activation rejects every node the executor cannot run. */
export function createAutomationRoutes(
  runtime: AutomationRuntime,
  authorizeProject: AuthorizeProjectPermission,
) {
  const app = new Hono<{ Bindings: AppBindings; Variables: AppVariables }>();
  const read = requireProjectPermission(authorizeProject, { workflows: ["read"] });
  const write = requireProjectPermission(authorizeProject, { workflows: ["write"] });
  const execute = requireProjectPermission(authorizeProject, { workflows: ["execute"] });

  app.use("*", async (context, next) => {
    if (!validIds(context, "projectId")) return failure(context, 400, "BAD_REQUEST");
    await next();
  });

  app.get("/", read, async (context) => {
    if (!validIds(context, "projectId")) return failure(context, 400, "BAD_REQUEST");
    const status = context.req.query("status");
    if (status !== undefined && status !== "active" && status !== "inactive") {
      return failure(context, 400, "BAD_REQUEST");
    }
    const rows = await runtime.list(context.env, projectId(context), status);
    return success(context, { items: rows.map(automationResponse) });
  });

  app.post("/", write, async (context) => {
    if (!validIds(context, "projectId")) return failure(context, 400, "BAD_REQUEST");
    const body = await readBoundedJson(context);
    if (body === "BODY_TOO_LARGE") return failure(context, 413, "BODY_TOO_LARGE");
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) return failure(context, 400, "BAD_REQUEST");
    try {
      const created = await runtime.create(context.env, {
        projectId: projectId(context),
        actorUserId: context.get("permissionActorId"),
        ...parsed.data,
      });
      return context.json(
        {
          success: true as const,
          data: automationResponse(created),
          request_id: context.get("requestId"),
        },
        201,
      );
    } catch (error) {
      return automationFailure(context, error);
    }
  });

  app.get("/:automationId", read, async (context) => {
    if (!validIds(context, "projectId", "automationId")) {
      return failure(context, 400, "BAD_REQUEST");
    }
    try {
      const graph = await runtime.getGraph(
        context.env,
        projectId(context),
        context.req.param("automationId"),
      );
      return success(context, {
        automation: automationResponse(graph.automation),
        nodes: graph.nodes.map(nodeResponse),
        edges: graph.edges.map(edgeResponse),
      });
    } catch (error) {
      return automationFailure(context, error);
    }
  });

  app.get("/:automationId/runs", read, async (context) => {
    if (!validIds(context, "projectId", "automationId")) {
      return failure(context, 400, "BAD_REQUEST");
    }
    const limitValue = context.req.query("limit") ?? "50";
    if (!/^[1-9]\d{0,2}$/.test(limitValue)) return failure(context, 400, "BAD_REQUEST");
    const limit = Number(limitValue);
    if (limit > 100) return failure(context, 400, "BAD_REQUEST");
    try {
      const rows = await runtime.listRuns(
        context.env,
        projectId(context),
        context.req.param("automationId"),
        limit,
      );
      return success(context, { items: rows.map(runResponse) });
    } catch (error) {
      return automationFailure(context, error);
    }
  });

  app.get("/:automationId/runs/:runId/steps", read, async (context) => {
    if (!validIds(context, "projectId", "automationId", "runId")) {
      return failure(context, 400, "BAD_REQUEST");
    }
    try {
      const rows = await runtime.listRunSteps(
        context.env,
        projectId(context),
        context.req.param("automationId"),
        context.req.param("runId"),
      );
      return success(context, { items: rows.map(runStepResponse) });
    } catch (error) {
      return automationFailure(context, error);
    }
  });

  app.patch("/:automationId", write, async (context) => {
    if (!validIds(context, "projectId", "automationId")) {
      return failure(context, 400, "BAD_REQUEST");
    }
    const body = await readBoundedJson(context);
    if (body === "BODY_TOO_LARGE") return failure(context, 413, "BODY_TOO_LARGE");
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) return failure(context, 400, "BAD_REQUEST");
    try {
      const updated = await runtime.update(
        context.env,
        projectId(context),
        context.req.param("automationId"),
        parsed.data,
      );
      return success(context, automationResponse(updated));
    } catch (error) {
      return automationFailure(context, error);
    }
  });

  for (const [suffix, active] of [
    ["activate", true],
    ["deactivate", false],
  ] as const) {
    app.post(`/:automationId/${suffix}`, execute, async (context) => {
      if (!validIds(context, "projectId", "automationId")) {
        return failure(context, 400, "BAD_REQUEST");
      }
      try {
        const updated = await runtime.setActive(
          context.env,
          projectId(context),
          context.req.param("automationId"),
          active,
        );
        return success(context, automationResponse(updated));
      } catch (error) {
        return automationFailure(context, error);
      }
    });
  }

  app.delete("/:automationId", write, async (context) => {
    if (!validIds(context, "projectId", "automationId")) {
      return failure(context, 400, "BAD_REQUEST");
    }
    try {
      await runtime.archive(context.env, projectId(context), context.req.param("automationId"));
      return success(context, {});
    } catch (error) {
      return automationFailure(context, error);
    }
  });

  app.post("/:automationId/nodes", write, async (context) => {
    if (!validIds(context, "projectId", "automationId")) {
      return failure(context, 400, "BAD_REQUEST");
    }
    const body = await readBoundedJson(context);
    if (body === "BODY_TOO_LARGE") return failure(context, 413, "BODY_TOO_LARGE");
    const parsed = nodeCreateSchema.safeParse(body);
    if (!parsed.success) return failure(context, 400, "BAD_REQUEST");
    try {
      const node = await runtime.addNode(
        context.env,
        projectId(context),
        context.req.param("automationId"),
        {
          kind: parsed.data.kind,
          type: parsed.data.type,
          config: parsed.data.config,
          posX: parsed.data.pos_x,
          posY: parsed.data.pos_y,
        },
      );
      return context.json(
        { success: true as const, data: nodeResponse(node), request_id: context.get("requestId") },
        201,
      );
    } catch (error) {
      return automationFailure(context, error);
    }
  });

  app.patch("/:automationId/nodes/:nodeId", write, async (context) => {
    if (!validIds(context, "projectId", "automationId", "nodeId")) {
      return failure(context, 400, "BAD_REQUEST");
    }
    const body = await readBoundedJson(context);
    if (body === "BODY_TOO_LARGE") return failure(context, 413, "BODY_TOO_LARGE");
    const parsed = nodeUpdateSchema.safeParse(body);
    if (!parsed.success) return failure(context, 400, "BAD_REQUEST");
    try {
      const node = await runtime.updateNode(
        context.env,
        projectId(context),
        context.req.param("automationId"),
        context.req.param("nodeId"),
        { config: parsed.data.config, posX: parsed.data.pos_x, posY: parsed.data.pos_y },
      );
      return success(context, nodeResponse(node));
    } catch (error) {
      return automationFailure(context, error);
    }
  });

  app.delete("/:automationId/nodes/:nodeId", write, async (context) => {
    if (!validIds(context, "projectId", "automationId", "nodeId")) {
      return failure(context, 400, "BAD_REQUEST");
    }
    try {
      await runtime.removeNode(
        context.env,
        projectId(context),
        context.req.param("automationId"),
        context.req.param("nodeId"),
      );
      return success(context, {});
    } catch (error) {
      return automationFailure(context, error);
    }
  });

  app.post("/:automationId/edges", write, async (context) => {
    if (!validIds(context, "projectId", "automationId")) {
      return failure(context, 400, "BAD_REQUEST");
    }
    const body = await readBoundedJson(context);
    if (body === "BODY_TOO_LARGE") return failure(context, 413, "BODY_TOO_LARGE");
    const parsed = edgeCreateSchema.safeParse(body);
    if (!parsed.success) return failure(context, 400, "BAD_REQUEST");
    try {
      const edge = await runtime.addEdge(
        context.env,
        projectId(context),
        context.req.param("automationId"),
        {
          sourceNodeId: parsed.data.source_node_id,
          sourceHandle: parsed.data.source_handle,
          targetNodeId: parsed.data.target_node_id,
        },
      );
      return context.json(
        { success: true as const, data: edgeResponse(edge), request_id: context.get("requestId") },
        201,
      );
    } catch (error) {
      return automationFailure(context, error);
    }
  });

  app.delete("/:automationId/edges/:edgeId", write, async (context) => {
    if (!validIds(context, "projectId", "automationId", "edgeId")) {
      return failure(context, 400, "BAD_REQUEST");
    }
    try {
      await runtime.removeEdge(
        context.env,
        projectId(context),
        context.req.param("automationId"),
        context.req.param("edgeId"),
      );
      return success(context, {});
    } catch (error) {
      return automationFailure(context, error);
    }
  });

  return app;
}
