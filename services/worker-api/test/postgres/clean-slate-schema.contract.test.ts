import { Client } from "pg";
import { describe, expect, it } from "vitest";

const databaseURL = process.env.PACA_TEST_DATABASE_URL?.trim();
const requireContracts = process.env.PACA_REQUIRE_POSTGRES_CONTRACTS === "true";
if (requireContracts && !databaseURL) throw new Error("PACA_TEST_DATABASE_URL_REQUIRED");

const contractDescribe = databaseURL ? describe : describe.skip;

contractDescribe("PostgreSQL clean-slate schema contract", () => {
  it("keeps Better Auth while removing legacy identity and data-migration tables", async () => {
    if (!databaseURL) throw new Error("PACA_TEST_DATABASE_URL_REQUIRED");
    const client = new Client({
      connectionString: databaseURL,
      connectionTimeoutMillis: 5_000,
      query_timeout: 5_000,
      statement_timeout: 5_000,
    });
    try {
      await client.connect();
      const result = await client.query<{
        better_auth_user: string | null;
        legacy_user: string | null;
        attachment_migration: string | null;
      }>(`
        select
          to_regclass('public."user"')::text as better_auth_user,
          to_regclass('public.users')::text as legacy_user,
          to_regclass('public.paca_attachment_migration_item')::text as attachment_migration
      `);

      expect(result.rows[0]).toEqual({
        better_auth_user: '"user"',
        legacy_user: null,
        attachment_migration: null,
      });
    } finally {
      await client.end().catch(() => undefined);
    }
  });
});
