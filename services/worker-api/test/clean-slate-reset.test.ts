import { describe, expect, it } from "vitest";

import {
  buildCleanSlateSchemaResetSQL,
  CLEAN_SLATE_RESET_CONFIRMATION,
  parseCleanSlateResetConfiguration,
  selectCleanSlateMigrationFiles,
} from "../scripts/lib/clean-slate-reset";

describe("clean-slate internal database reset policy", () => {
  it("requires the exact destructive confirmation before parsing a target", () => {
    expect(() => parseCleanSlateResetConfiguration({ PACA_PLANETSCALE_ORG: "example" })).toThrow(
      CLEAN_SLATE_RESET_CONFIRMATION,
    );
  });

  it("accepts only the internal branch and safe PlanetScale names", () => {
    const base = {
      PACA_RESET_INTERNAL_CONFIRM: CLEAN_SLATE_RESET_CONFIRMATION,
      PACA_PLANETSCALE_ORG: "example-org",
    };

    expect(parseCleanSlateResetConfiguration(base)).toEqual({
      organization: "example-org",
      database: "paca",
      branch: "internal",
      runtimeRoleName: "paca-worker-internal",
    });
    expect(
      parseCleanSlateResetConfiguration({
        ...base,
        PACA_PLANETSCALE_ORG: "463708580",
      }).organization,
    ).toBe("463708580");
    expect(() =>
      parseCleanSlateResetConfiguration({
        ...base,
        PACA_PLANETSCALE_TARGET_BRANCH: "main",
      }),
    ).toThrow("TARGET_BRANCH_MUST_BE_INTERNAL");
    expect(() =>
      parseCleanSlateResetConfiguration({
        ...base,
        PACA_PLANETSCALE_DATABASE: "paca; drop database paca",
      }),
    ).toThrow("PACA_PLANETSCALE_DATABASE_INVALID");
  });

  it("requires one contiguous migration sequence beginning at 0000", () => {
    expect(
      selectCleanSlateMigrationFiles([
        "README.md",
        "0001_permissions.sql",
        "0000_auth.sql",
        "0002_project.sql",
      ]),
    ).toEqual(["0000_auth.sql", "0001_permissions.sql", "0002_project.sql"]);
    expect(() => selectCleanSlateMigrationFiles(["0001_permissions.sql"])).toThrow(
      "PACA_RESET_MIGRATION_SEQUENCE_INVALID",
    );
    expect(() => selectCleanSlateMigrationFiles(["0000_auth.sql", "0002_project.sql"])).toThrow(
      "PACA_RESET_MIGRATION_SEQUENCE_INVALID",
    );
  });

  it("drops a postgres-owned schema and restores ownership to the temporary role", () => {
    expect(buildCleanSlateSchemaResetSQL("pscale_api_123abc")).toBe(
      'set role postgres; drop schema public cascade; reset role; create schema public authorization "pscale_api_123abc"; revoke create on schema public from public',
    );
    expect(() => buildCleanSlateSchemaResetSQL('pscale_api_bad"; drop database postgres')).toThrow(
      "TEMP_MIGRATION_DATABASE_ROLE_INVALID",
    );
  });
});
