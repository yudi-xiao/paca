import { describe, expect, it } from "vitest";
import {
  assertRecentProductionBackup,
  assertUnpublishedProduction,
  parseOperatorRole,
} from "../scripts/lib/production-database";

describe("unpublished production operator boundaries", () => {
  it("pins a TLS-verified temporary credential to main and rejects internal/foreign hosts", () => {
    const payload = {
      id: "temporary",
      database_url:
        "postgresql://pscale_api_test.1taj95uxia8x:private@aws-ap-southeast-1-2.pg.psdb.cloud:5432/postgres?sslmode=disable",
    };
    expect(parseOperatorRole(payload).clientConfig.ssl).toEqual({ rejectUnauthorized: true });
    for (const url of [
      payload.database_url.replace("1taj95uxia8x", "dshooho15033"),
      payload.database_url.replace(".pg.psdb.cloud", ".example.com"),
      payload.database_url.replace("/postgres", "/other"),
    ]) {
      expect(() => parseOperatorRole({ ...payload, database_url: url })).toThrow(
        "PRODUCTION_OPERATOR_ROLE_INVALID",
      );
    }
  });

  it("requires a completed recent unexpired named backup", () => {
    const now = Date.parse("2026-10-10T10:15:00Z");
    const backup = {
      id: "backup",
      name: "paca-pre-production-clean-slate-20261010",
      state: "success",
      completed_at: "2026-10-10T10:02:10Z",
      expires_at: "2026-11-10T10:00:00Z",
    };
    expect(() => assertRecentProductionBackup(backup, now)).not.toThrow();
    for (const changed of [
      { state: "pending" },
      { name: "other" },
      { completed_at: "2026-10-09T10:00:00Z" },
      { completed_at: "2026-10-10T11:00:00Z" },
      { expires_at: "2026-10-10T10:00:00Z" },
    ]) {
      expect(() => assertRecentProductionBackup({ ...backup, ...changed }, now)).toThrow();
    }
  });

  it("refuses reset once any Worker consumes main or production was deployed", () => {
    expect(() =>
      assertUnpublishedProduction([], [{ id: "paca-worker-api-internal" }]),
    ).not.toThrow();
    expect(() =>
      assertUnpublishedProduction([{ worker: "unrelated", hyperdriveId: "main" }], []),
    ).toThrow();
    expect(() => assertUnpublishedProduction([], [{ id: "paca-worker-api-production" }])).toThrow();
  });
});
