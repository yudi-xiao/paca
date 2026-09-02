import { describe, expect, it } from "vitest";

import { apiMigrationManifest, matchUnmigratedApi } from "../src/migration/manifest";

describe("API migration manifest", () => {
  it("keeps one unique entry and at least one route prefix per tracked domain", () => {
    const domains = apiMigrationManifest.map((entry) => entry.domain);
    expect(new Set(domains).size).toBe(domains.length);
    expect(apiMigrationManifest.every((entry) => entry.routePrefixes.length > 0)).toBe(true);
  });

  it("classifies retained project and global routes without matching near misses", () => {
    expect(matchUnmigratedApi("/api/v1/projects/project-1/environments/env-1")).toMatchObject({
      domain: "environments",
      status: "container-retained",
      authority: "go-api",
    });
    expect(matchUnmigratedApi("/api/v1/admin/agents/agent-1")).toMatchObject({
      domain: "agent-management",
    });
    expect(matchUnmigratedApi("/api/v1/projects/project-1/automations")).toMatchObject({
      domain: "automations",
    });
    expect(matchUnmigratedApi("/api/v1/projects/project-1/environmental-report")).toBeNull();
    expect(matchUnmigratedApi("/api/v1/projects")).toBeNull();
  });

  it("does not classify Worker-owned bridge routes as retained Go routes", () => {
    expect(matchUnmigratedApi("/api/v1/users/me/notifications")).toBeNull();
    expect(matchUnmigratedApi("/api/v1/plugins")).toBeNull();
  });
});
