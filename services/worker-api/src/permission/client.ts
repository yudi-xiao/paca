import type { BetterAuthClientPlugin } from "better-auth/client";

import type { pacaPermission } from "./plugin";

export function pacaPermissionClient() {
  return {
    id: "paca-permission",
    $InferServerPlugin: {} as ReturnType<typeof pacaPermission>,
  } satisfies BetterAuthClientPlugin;
}
