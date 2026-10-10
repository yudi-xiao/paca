import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { requireLocalTestDatabase } from "../../scripts/lib/postgres-test-database";
import { grantRuntimeRole, verifyRuntimeRole } from "../../scripts/lib/runtime-role";

const databaseURL = process.env.PACA_TEST_DATABASE_URL?.trim();
if (process.env.PACA_REQUIRE_POSTGRES_CONTRACTS === "true" && !databaseURL)
  throw new Error("PACA_TEST_DATABASE_URL_REQUIRED");

(databaseURL ? describe : describe.skip)("runtime PostgreSQL role privileges", () => {
  it("requires every CRUD action on every table and denies DDL/ledger access", async () => {
    const { connectionString } = requireLocalTestDatabase();
    const client = new Client({ connectionString });
    const role = `pscale_api_${crypto.randomUUID().replaceAll("-", "")}`;
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE ROLE "${role}"`);
      await grantRuntimeRole(client, role);
      await expect(verifyRuntimeRole(client, role)).resolves.toBeUndefined();
      for (const action of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        await client.query(`REVOKE ${action} ON public.paca_task FROM "${role}"`);
        await expect(verifyRuntimeRole(client, role)).rejects.toThrow(
          "RUNTIME_ROLE_PRIVILEGES_INVALID",
        );
        await client.query(`GRANT ${action} ON public.paca_task TO "${role}"`);
      }
      await expect(verifyRuntimeRole(client, role)).resolves.toBeUndefined();
      await client.query(`GRANT CREATE ON SCHEMA public TO "${role}"`);
      await expect(verifyRuntimeRole(client, role)).rejects.toThrow(
        "RUNTIME_ROLE_PRIVILEGES_INVALID",
      );
      await client.query(`REVOKE CREATE ON SCHEMA public FROM "${role}"`);
      await client.query(`GRANT pg_read_all_data TO "${role}"`);
      await expect(verifyRuntimeRole(client, role)).rejects.toThrow(
        "RUNTIME_ROLE_PRIVILEGES_INVALID",
      );
      await client.query(`REVOKE pg_read_all_data FROM "${role}"`);
      await client.query(`ALTER ROLE "${role}" CREATEDB`);
      await expect(verifyRuntimeRole(client, role)).rejects.toThrow(
        "RUNTIME_ROLE_PRIVILEGES_INVALID",
      );
      await client.query(`ALTER ROLE "${role}" NOCREATEDB`);
      await client.query(`GRANT SELECT ON public.paca_schema_migration TO "${role}"`);
      await expect(verifyRuntimeRole(client, role)).rejects.toThrow(
        "RUNTIME_ROLE_PRIVILEGES_INVALID",
      );
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end();
    }
  });
});
