import { describe, expect, it } from "vitest";
import { selectCleanSlateMigrationFiles } from "../scripts/lib/clean-slate-reset";

describe("migration sequence", () => {
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
});
