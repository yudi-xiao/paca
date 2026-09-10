import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { hasEveryPermission } from "../src/permission/evaluator";
import { type PermissionGrant, permissionGrantsFromLegacyMap } from "../src/permission/statement";

type ShadowDecisionCase = {
  name: string;
  actor: "user" | "legacy_agent";
  scope: "global" | "project";
  projectMember?: boolean;
  grantSets: string[][];
  required: string[];
  allowed: boolean;
};

type ShadowDecisionCorpus = {
  version: number;
  cases: ShadowDecisionCase[];
};

function parseLegacyPermissionKeys(keys: readonly string[]): PermissionGrant[] {
  return permissionGrantsFromLegacyMap(
    "systemRole",
    Object.fromEntries(keys.map((permission) => [permission, true])),
  );
}

describe("Go Authorizer to Better Auth shadow decisions", () => {
  it("matches the shared global/project/multi-role/wildcard/legacy-Agent corpus", async () => {
    const contents = await readFile(
      new URL("../../api/testdata/authorization-shadow-decisions.json", import.meta.url),
      "utf8",
    );
    const corpus = JSON.parse(contents) as ShadowDecisionCorpus;
    const caseNames = corpus.cases.map(({ name }) => name);

    expect(corpus.version).toBe(1);
    expect(caseNames.length).toBeGreaterThan(0);
    expect(new Set(caseNames).size).toBe(caseNames.length);

    for (const decision of corpus.cases) {
      const granted = decision.grantSets.flatMap(parseLegacyPermissionKeys);
      const required = parseLegacyPermissionKeys(decision.required);
      expect(
        hasEveryPermission(granted, required),
        `${decision.name} (${decision.actor}/${decision.scope})`,
      ).toBe(decision.allowed);
    }
  });
});
