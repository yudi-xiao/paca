import type { MiddlewareHandler } from "hono";

import type { AppBindings, AppVariables } from "../bindings";
import { readTrustedOrigins } from "./runtime";

export const protectAuthOrigin: MiddlewareHandler<{
  Bindings: AppBindings;
  Variables: AppVariables;
}> = async (context, next) => {
  const origin = context.req.header("origin");
  const trustedOrigins = readTrustedOrigins(context.env);
  const isMutation = !["GET", "HEAD", "OPTIONS"].includes(context.req.method);
  const hasCookie = Boolean(context.req.header("cookie"));

  if (isMutation && hasCookie && !origin) {
    return context.json(
      {
        status: "forbidden",
        code: "MISSING_ORIGIN",
        requestId: context.get("requestId"),
      },
      403,
    );
  }

  if (origin && !trustedOrigins.includes(origin)) {
    return context.json(
      {
        status: "forbidden",
        code: "UNTRUSTED_ORIGIN",
        requestId: context.get("requestId"),
      },
      403,
    );
  }

  if (context.req.method === "OPTIONS") {
    if (!origin) {
      return context.body(null, 204);
    }

    context.header("access-control-allow-origin", origin);
    context.header("access-control-allow-credentials", "true");
    context.header("access-control-allow-methods", "GET, POST, OPTIONS");
    context.header("access-control-allow-headers", "Content-Type, Authorization");
    context.header("access-control-max-age", "600");
    context.header("vary", "Origin");
    return context.body(null, 204);
  }

  await next();

  if (origin) {
    context.header("access-control-allow-origin", origin);
    context.header("access-control-allow-credentials", "true");
    context.header("vary", "Origin");
  }
};
