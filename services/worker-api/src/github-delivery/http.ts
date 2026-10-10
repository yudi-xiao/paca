import { type Context, Hono } from "hono";
import * as z from "zod";
import type { AppBindings, AppVariables } from "../bindings";
import {
  type AuthorizeProjectPermission,
  type AuthorizeSystemPermission,
  requireProjectPermission,
  requireSystemPermission,
} from "../permission/http";
import { GitHubDeliveryError } from "./evidence";
import type { GitHubDeliveryRuntime } from "./runtime";
import {
  DeliveryWorkflowError,
  deliveryDecisionSchema,
  deliveryRefreshSchema,
  deliverySubmissionSchema,
  repositoryBindingInputSchema,
  type TaskDelivery,
} from "./service";

type DeliveryContext = Context<{ Bindings: AppBindings; Variables: AppVariables }>;
async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
    throw new DeliveryWorkflowError("DELIVERY_INPUT_INVALID");
  const reader = request.body?.getReader();
  if (!reader) throw new DeliveryWorkflowError("DELIVERY_INPUT_INVALID");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32768) {
        await reader.cancel().catch(() => undefined);
        throw new DeliveryWorkflowError("DELIVERY_BODY_TOO_LARGE");
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
    if (error instanceof DeliveryWorkflowError) throw error;
    throw new DeliveryWorkflowError("DELIVERY_INPUT_INVALID");
  } finally {
    reader.releaseLock();
  }
}
function failure(context: DeliveryContext, error: unknown) {
  if (!(error instanceof DeliveryWorkflowError) && !(error instanceof GitHubDeliveryError))
    throw error;
  const status =
    error instanceof GitHubDeliveryError
      ? 503
      : error.code === "DELIVERY_BODY_TOO_LARGE"
        ? 413
        : error.code === "DELIVERY_INPUT_INVALID"
          ? 400
          : error.code === "DELIVERY_NOT_FOUND"
            ? 404
            : error.code === "DELIVERY_PERMISSION_DENIED" ||
                error.code === "DELIVERY_SCOPE_MISMATCH"
              ? 403
              : 409;
  return context.json(
    {
      success: false as const,
      error_code: error.code,
      error: error.code,
      request_id: context.get("requestId"),
    },
    status,
  );
}
function validScope(context: DeliveryContext, task = false) {
  if (
    !z.uuid().safeParse(context.req.param("projectId")).success ||
    (task && !z.uuid().safeParse(context.req.param("taskId")).success)
  )
    throw new DeliveryWorkflowError("DELIVERY_INPUT_INVALID");
}
function display(delivery: TaskDelivery | null) {
  if (!delivery) return null;
  const observed = Date.parse(delivery.evidence.observedAt);
  const requiresRefresh =
    !Number.isFinite(observed) || Date.now() - observed > 60000 || observed > Date.now() + 5000;
  const stale = requiresRefresh && ["accepted", "awaiting_acceptance"].includes(delivery.state);
  return {
    ...delivery,
    state: stale ? "stale" : delivery.state,
    requiresRefresh,
    lastAcceptance: delivery.acceptedAt
      ? { actorId: delivery.acceptedBy, at: delivery.acceptedAt.toISOString() }
      : null,
    acceptedBy: stale ? null : delivery.acceptedBy,
    acceptedAt: stale ? null : (delivery.acceptedAt?.toISOString() ?? null),
    requestedChangesAt: delivery.requestedChangesAt?.toISOString() ?? null,
    updatedAt: delivery.updatedAt.toISOString(),
  };
}
export function createGitHubDeliveryRoutes(
  runtime: GitHubDeliveryRuntime,
  authorize: AuthorizeProjectPermission,
  systemAuthorize: AuthorizeSystemPermission,
) {
  const app = new Hono<{ Bindings: AppBindings; Variables: AppVariables }>();
  const repoPath = "/api/v1/projects/:projectId/github-repository";
  const taskPath = "/api/v1/projects/:projectId/tasks/:taskId/delivery";
  app.use("*", async (context, next) => {
    context.header("cache-control", "no-store");
    await next();
  });
  app.get(
    repoPath,
    requireProjectPermission(authorize, { projects: ["read"] }),
    async (context) => {
      try {
        validScope(context);
        const binding = await runtime.binding(context.env, context.req.param("projectId"));
        return context.json({
          success: true as const,
          data: binding ? { ...binding, updatedAt: binding.updatedAt.toISOString() } : null,
          request_id: context.get("requestId"),
        });
      } catch (error) {
        return failure(context, error);
      }
    },
  );
  app.put(
    repoPath,
    requireProjectPermission(authorize, { projects: ["write"] }),
    requireSystemPermission(systemAuthorize, { settings: ["write"] }),
    async (context) => {
      try {
        validScope(context);
        const input = repositoryBindingInputSchema.safeParse(await readJson(context.req.raw));
        if (!input.success) throw new DeliveryWorkflowError("DELIVERY_INPUT_INVALID");
        const saved = await runtime.configure(
          context.env,
          context.req.raw,
          context.req.param("projectId"),
          context.get("permissionActorId"),
          input.data,
        );
        return context.json({
          success: true as const,
          data: { ...saved, updatedAt: saved.updatedAt.toISOString() },
          request_id: context.get("requestId"),
        });
      } catch (error) {
        return failure(context, error);
      }
    },
  );
  app.get(taskPath, requireProjectPermission(authorize, { tasks: ["read"] }), async (context) => {
    try {
      validScope(context, true);
      return context.json({
        success: true as const,
        data: display(
          await runtime.delivery(
            context.env,
            context.req.param("projectId"),
            context.req.param("taskId"),
          ),
        ),
        request_id: context.get("requestId"),
      });
    } catch (error) {
      return failure(context, error);
    }
  });
  for (const operation of ["submit", "refresh", "decide"] as const) {
    app.post(
      operation === "submit"
        ? taskPath
        : `${taskPath}/${operation === "decide" ? "decision" : "refresh"}`,
      requireProjectPermission(authorize, { tasks: ["write"] }),
      async (context) => {
        try {
          validScope(context, true);
          const schema =
            operation === "submit"
              ? deliverySubmissionSchema
              : operation === "refresh"
                ? deliveryRefreshSchema
                : deliveryDecisionSchema;
          const input = schema.safeParse(await readJson(context.req.raw));
          if (!input.success) throw new DeliveryWorkflowError("DELIVERY_INPUT_INVALID");
          const saved = await runtime[operation](
            context.env,
            context.req.raw,
            context.req.param("projectId"),
            context.req.param("taskId"),
            context.get("permissionActorId"),
            input.data,
          );
          return context.json({
            success: true as const,
            data: display(saved),
            request_id: context.get("requestId"),
          });
        } catch (error) {
          return failure(context, error);
        }
      },
    );
  }
  return app;
}
