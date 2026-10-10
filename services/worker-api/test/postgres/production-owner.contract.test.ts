import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { selectCleanSlateMigrationFiles } from "../../scripts/lib/clean-slate-reset";
import { requireLocalTestDatabase } from "../../scripts/lib/postgres-test-database";
import { createProductionOwner } from "../../scripts/lib/production-owner";
import { createAuth } from "../../src/auth/runtime";
import type { AppBindings } from "../../src/bindings";
import * as schema from "../../src/db/schema";

const databaseURL = process.env.PACA_TEST_DATABASE_URL?.trim();
if (process.env.PACA_REQUIRE_POSTGRES_CONTRACTS === "true" && !databaseURL)
  throw new Error("PACA_TEST_DATABASE_URL_REQUIRED");

(databaseURL ? describe : describe.skip)("production first-owner initialization", () => {
  it("rolls back failed provisioning, creates the canonical Owner once, and revokes the bootstrap session", async () => {
    const { connectionString } = requireLocalTestDatabase();
    const name = `paca_owner_${crypto.randomUUID().replaceAll("-", "")}_test`;
    const admin = new Client({ connectionString });
    await admin.connect();
    const isolated = new URL(connectionString);
    isolated.pathname = `/${name}`;
    const client = new Client({ connectionString: isolated.toString() });
    let created = false;
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      created = true;
      await client.connect();
      const migrations = new URL("../../drizzle/", import.meta.url);
      for (const file of selectCleanSlateMigrationFiles(await readdir(migrations))) {
        await client.query(await readFile(new URL(file, migrations), "utf8"));
      }
      const db = drizzle(client, { schema });
      const credential = {
        email: "owner@example.com",
        name: "Owner",
        password: randomBytes(24).toString("hex"),
      };
      await client.query(
        "UPDATE paca_organization_role SET name = 'MISSING_OWNER' WHERE name = 'OWNER'",
      );
      await expect(createProductionOwner(db, credential)).rejects.toThrow();
      const failed = await client.query(
        'SELECT (SELECT count(*)::int FROM "user") AS users, (SELECT count(*)::int FROM session) AS sessions, (SELECT count(*)::int FROM paca_user_system_role) AS assignments',
      );
      expect(failed.rows).toEqual([{ users: 0, sessions: 0, assignments: 0 }]);
      await client.query(
        "UPDATE paca_organization_role SET name = 'OWNER' WHERE name = 'MISSING_OWNER'",
      );
      await createProductionOwner(db, credential);
      await expect(
        createProductionOwner(db, { ...credential, password: randomBytes(24).toString("hex") }),
      ).rejects.toThrow("PRODUCTION_OWNER_ALREADY_INITIALIZED");
      const counts = await client.query(
        'SELECT (SELECT count(*)::int FROM "user") AS users, (SELECT count(*)::int FROM session) AS sessions, (SELECT count(*)::int FROM paca_user_system_role) AS assignments',
      );
      expect(counts.rows).toEqual([{ users: 1, sessions: 0, assignments: 1 }]);
      const auth = createAuth(db, {
        ENVIRONMENT: "production",
        BETTER_AUTH_SECRET: randomBytes(48).toString("hex"),
        BETTER_AUTH_URL: "https://paca.howlearnwood.com",
        TRUSTED_ORIGINS: "https://paca.howlearnwood.com",
      } as AppBindings);
      const login = await auth.api.signInEmail({
        body: { email: credential.email, password: credential.password },
        asResponse: true,
      });
      expect(login.status).toBe(200);
      const cookie = login.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      expect(
        (await auth.api.signOut({ headers: new Headers({ cookie }), asResponse: true })).status,
      ).toBe(200);
    } finally {
      await client.end().catch(() => undefined);
      if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
    }
  }, 30_000);
});
