import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import type { AppBindings } from "../src/bindings";

const UUID = "00000000-0000-4000-8000-000000000001";

const PUBLIC_ROUTES = new Set([
  "GET /health",
  "GET /.well-known/agent-configuration",
  "GET /api/v1/branding",
  "GET /api/v1/branding/images/:slot/:fileId",
  "GET /api/v1/version",
]);

const AUTH_ROUTE_PREFIX = "/api/auth/";

function concretePath(pattern: string): string {
  return pattern.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (_match, name: string) => {
    if (name === "partNumber") return "1";
    if (name === "slot") return "logo";
    return UUID;
  });
}

function requestInit(method: string): RequestInit {
  if (["GET", "HEAD"].includes(method)) return { method };
  return {
    method,
    headers: { "content-type": "application/json" },
    body: "{}",
  };
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && path.endsWith(".ts") ? [path] : [];
    }),
  );
  return nested.flat();
}

describe("permission architecture boundary", () => {
  it("rejects every non-public Worker API route before domain runtimes are reached", async () => {
    const runtimeReached = vi.fn(() => {
      throw new Error("unauthenticated request reached a domain runtime");
    });
    const app = createApp({
      authorizeOrganizationPermission: async () => ({ authenticated: false }),
      authorizeProjectPermission: async () => ({ authenticated: false }),
      authorizeSystemPermission: async () => ({ authenticated: false }),
      currentAgentSession: async () => null,
      currentUserSession: async () => null,
      loadSystemPermissions: async () => ({ authenticated: false }),
      // A missing authentication boundary should fail loudly instead of opening
      // a real database through a default runtime.
      projects: new Proxy({}, { get: () => runtimeReached }) as NonNullable<
        Parameters<typeof createApp>[0]
      >["projects"],
      log: vi.fn(),
    });
    const bindings = { ENVIRONMENT: "test" } as AppBindings;
    const routes = new Map<string, { method: string; path: string }>();

    for (const route of app.routes) {
      if (route.method === "ALL") continue;
      const key = `${route.method} ${route.path}`;
      routes.set(key, { method: route.method, path: route.path });
    }

    const protectedRoutes = [...routes.entries()].filter(
      ([key, route]) =>
        !PUBLIC_ROUTES.has(key) &&
        !route.path.endsWith("/*") &&
        !route.path.startsWith(AUTH_ROUTE_PREFIX) &&
        route.path !== "/internal/health/database",
    );

    expect(protectedRoutes.length).toBeGreaterThan(80);
    for (const [key, route] of protectedRoutes) {
      const response = await app.request(
        concretePath(route.path),
        requestInit(route.method),
        bindings,
      );
      expect(response.status, key).toBe(401);
    }
    expect(runtimeReached).not.toHaveBeenCalled();
  });

  it("keeps role membership tables inside designated permission adapters", async () => {
    const sourceRoot = resolve(import.meta.dirname, "../src");
    const allowedFiles = new Set([
      "db/schema/paca.ts",
      "organization/access-postgres-repository.ts",
      "permission/postgres-store.ts",
      "permission/postgres-system-role-repository.ts",
      "project/access-postgres-repository.ts",
      "project/postgres-repository.ts",
    ]);
    const permissionStorageSymbols =
      /\bpaca(?:SystemRoles|SystemRolePermissions|UserSystemRoles|OrganizationRoles|OrganizationRolePermissions|OrganizationMemberRoles|ProjectRoles|RolePermissions|ProjectMemberRoles)\b/;
    const violations: string[] = [];

    for (const file of await sourceFiles(sourceRoot)) {
      const projectPath = relative(sourceRoot, file);
      if (allowedFiles.has(projectPath)) continue;
      if (permissionStorageSymbols.test(await readFile(file, "utf8"))) violations.push(projectPath);
    }

    expect(violations).toEqual([]);
  });
});
