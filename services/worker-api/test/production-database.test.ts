import { describe, expect, it } from "vitest";
import { parseOperatorRole } from "../scripts/lib/production-database";

describe("production operator identity", () => {
  it("pins a TLS-verified temporary credential to the existing database", () => {
    const payload = {
      id: "temporary",
      database_url:
        "postgresql://pscale_api_test.dshooho15033:private@aws-ap-southeast-1-2.pg.psdb.cloud:5432/postgres?sslmode=disable",
    };
    expect(parseOperatorRole(payload).clientConfig.ssl).toEqual({ rejectUnauthorized: true });
    for (const url of [
      payload.database_url.replace("dshooho15033", "1taj95uxia8x"),
      payload.database_url.replace(".pg.psdb.cloud", ".example.com"),
      payload.database_url.replace("/postgres", "/other"),
    ]) {
      expect(() => parseOperatorRole({ ...payload, database_url: url })).toThrow(
        "PRODUCTION_OPERATOR_ROLE_INVALID",
      );
    }
  });
});
