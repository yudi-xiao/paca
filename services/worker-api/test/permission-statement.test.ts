import { describe, expect, it } from "vitest";

import { canDelegatePermissionGrants } from "../src/permission/evaluator";
import {
  type PermissionGrant,
  permissionGrantsFromLegacyMap,
  permissionGrantsToLegacyMap,
} from "../src/permission/statement";

describe("legacy permission map adapter", () => {
  it("parses multi-segment legacy resources and ignores disabled entries", () => {
    const grants = permissionGrantsFromLegacyMap("project", {
      "project.members.read": true,
      "project.roles.write": true,
      "tasks.read": false,
    });

    expect(grants).toEqual([
      { resource: "projectMembers", action: "read" },
      { resource: "projectRoles", action: "write" },
    ]);
    expect(permissionGrantsToLegacyMap(grants)).toEqual({
      "project.members.read": true,
      "project.roles.write": true,
    });
  });

  it("accepts the future-proof global wildcard only at system scope", () => {
    expect(permissionGrantsFromLegacyMap("system", { "*": true })).toEqual([
      { resource: "*", action: "*" },
    ]);
    expect(() => permissionGrantsFromLegacyMap("project", { "*": true })).toThrowError(
      "PERMISSION_RESOURCE_SCOPE_INVALID",
    );
  });

  it("rejects unknown, out-of-scope, and malformed permissions", () => {
    expect(() => permissionGrantsFromLegacyMap("system", { "tasks.read": true })).toThrowError(
      "PERMISSION_RESOURCE_SCOPE_INVALID",
    );
    expect(() => permissionGrantsFromLegacyMap("system", { "users.fly": true })).toThrowError(
      "PERMISSION_ACTION_INVALID",
    );
    expect(() => permissionGrantsFromLegacyMap("system", { "users.read": "yes" })).toThrowError(
      "PERMISSION_MAP_VALUE_INVALID",
    );
  });
});

describe("permission delegation ceiling", () => {
  it("allows only grants already held by the actor", () => {
    const actor = [
      { resource: "users", action: "read" },
      { resource: "users", action: "write" },
    ] satisfies PermissionGrant[];

    expect(canDelegatePermissionGrants(actor, [{ resource: "users", action: "read" }])).toBe(true);
    expect(canDelegatePermissionGrants(actor, [{ resource: "users", action: "delete" }])).toBe(
      false,
    );
  });

  it("requires every declared action before delegating a resource wildcard", () => {
    const complete = ["read", "write", "delete"].map((action) => ({
      resource: "users" as const,
      action,
    }));

    expect(canDelegatePermissionGrants(complete, [{ resource: "users", action: "*" }])).toBe(true);
    expect(
      canDelegatePermissionGrants(complete.slice(0, 2), [{ resource: "users", action: "*" }]),
    ).toBe(false);
  });

  it("does not synthesize a global wildcard from today's finite statement", () => {
    expect(
      canDelegatePermissionGrants(
        [{ resource: "users", action: "*" }],
        [{ resource: "*", action: "*" }],
      ),
    ).toBe(false);
    expect(
      canDelegatePermissionGrants(
        [{ resource: "*", action: "*" }],
        [{ resource: "*", action: "*" }],
      ),
    ).toBe(true);
  });
});
