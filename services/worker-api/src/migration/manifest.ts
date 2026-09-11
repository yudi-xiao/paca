export type ApiMigrationStatus = "worker-native" | "bridge" | "container-retained";

export type ApiMigrationDomain = "agent-management" | "automations" | "environments" | "plugins";

export type ApiMigrationEntry = {
  domain: ApiMigrationDomain;
  status: ApiMigrationStatus;
  authority: "worker-postgres" | "worker-empty-projection" | "go-api";
  dependsOn: readonly string[];
  owner: "worker" | "go-api";
  rollback: "worker-version";
  routePrefixes: readonly string[];
  workerNativeRoutes?: readonly {
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    path: string;
  }[];
};

/**
 * Machine-readable boundary for API domains that are not fully Worker-native yet.
 *
 * This intentionally does not proxy Better Auth sessions to the Go API. The two
 * runtimes do not share an authenticated principal contract yet, so an implicit
 * proxy would either fail open or create a second authorization authority. A
 * deployment rollback remains the only supported traffic rollback. The
 * clean-slate migration deliberately will not add an identity or data bridge.
 */
export const apiMigrationManifest = [
  {
    domain: "plugins",
    status: "bridge",
    authority: "worker-empty-projection",
    dependsOn: ["Better Auth Session", "plugin runtime isolation"],
    owner: "worker",
    rollback: "worker-version",
    routePrefixes: ["/api/v1/plugins"],
  },
  {
    domain: "agent-management",
    status: "container-retained",
    authority: "go-api",
    dependsOn: [
      "Agent Auth-backed writes and configuration migration",
      "conversation protocol migration",
    ],
    owner: "go-api",
    rollback: "worker-version",
    routePrefixes: ["/api/v1/projects/:projectId/agents", "/api/v1/admin/agents"],
    workerNativeRoutes: [{ method: "GET", path: "/api/v1/projects/:projectId/agents" }],
  },
  {
    domain: "environments",
    status: "container-retained",
    authority: "go-api",
    dependsOn: [
      "folders, SSH and port-forward lifecycle implementation",
      "browser-to-environment connection authorization contract",
    ],
    owner: "go-api",
    rollback: "worker-version",
    routePrefixes: ["/api/v1/projects/:projectId/environments", "/api/v1/environments"],
    workerNativeRoutes: [
      { method: "GET", path: "/api/v1/projects/:projectId/environments" },
      { method: "POST", path: "/api/v1/projects/:projectId/environments" },
      { method: "GET", path: "/api/v1/projects/:projectId/environments/:environmentId" },
      { method: "PATCH", path: "/api/v1/projects/:projectId/environments/:environmentId" },
      { method: "DELETE", path: "/api/v1/projects/:projectId/environments/:environmentId" },
      {
        method: "POST",
        path: "/api/v1/projects/:projectId/environments/:environmentId/terminal-ticket",
      },
    ],
  },
  {
    domain: "automations",
    status: "container-retained",
    authority: "go-api",
    dependsOn: ["automation repository migration", "Queue and Workflow event contract"],
    owner: "go-api",
    rollback: "worker-version",
    routePrefixes: ["/api/v1/projects/:projectId/automations", "/api/v1/webhooks/automations"],
  },
] as const satisfies readonly ApiMigrationEntry[];

export type UnmigratedApiMatch = Pick<
  ApiMigrationEntry,
  "domain" | "status" | "authority" | "owner" | "rollback"
>;

function pathMatchesPrefix(path: string, prefix: string): boolean {
  const pathSegments = path.split("/").filter(Boolean);
  const prefixSegments = prefix.split("/").filter(Boolean);
  if (pathSegments.length < prefixSegments.length) return false;

  return prefixSegments.every((segment, index) => {
    if (segment.startsWith(":") && segment.length > 1) {
      return Boolean(pathSegments[index]?.length);
    }
    return pathSegments[index] === segment;
  });
}

function pathMatchesRoute(path: string, pattern: string): boolean {
  const pathSegments = path.split("/").filter(Boolean);
  const patternSegments = pattern.split("/").filter(Boolean);
  return (
    pathSegments.length === patternSegments.length &&
    patternSegments.every((segment, index) => {
      if (segment.startsWith(":") && segment.length > 1) {
        return Boolean(pathSegments[index]?.length);
      }
      return pathSegments[index] === segment;
    })
  );
}

export function matchUnmigratedApi(path: string, method = "GET"): UnmigratedApiMatch | null {
  for (const entry of apiMigrationManifest) {
    if (entry.status !== "container-retained") continue;
    if (!entry.routePrefixes.some((prefix) => pathMatchesPrefix(path, prefix))) continue;
    const workerNativeRoutes = "workerNativeRoutes" in entry ? entry.workerNativeRoutes : undefined;
    if (
      workerNativeRoutes?.some(
        (route) => route.method === method && pathMatchesRoute(path, route.path),
      )
    ) {
      continue;
    }
    return {
      domain: entry.domain,
      status: entry.status,
      authority: entry.authority,
      owner: entry.owner,
      rollback: entry.rollback,
    };
  }
  return null;
}
