import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { describe } from "vitest";

import * as schema from "../../src/db/schema";
import { organization, user } from "../../src/db/schema";
import { PostgresProjectRepository } from "../../src/project/postgres-repository";
import { projectRepositoryContract } from "../contracts/project-repository.contract";

const databaseURL = process.env.PACA_TEST_DATABASE_URL?.trim();
const requireContracts = process.env.PACA_REQUIRE_POSTGRES_CONTRACTS === "true";
if (requireContracts && !databaseURL) throw new Error("PACA_TEST_DATABASE_URL_REQUIRED");

const contractDescribe = databaseURL ? describe : describe.skip;

contractDescribe("PostgreSQL repository contracts", () => {
  projectRepositoryContract("PostgresProjectRepository", async () => {
    if (!databaseURL) throw new Error("PACA_TEST_DATABASE_URL_REQUIRED");
    const client = new Client({
      connectionString: databaseURL,
      connectionTimeoutMillis: 5_000,
      query_timeout: 5_000,
      statement_timeout: 5_000,
    });
    await client.connect();
    const database = drizzle(client, { schema });
    const suffix = crypto.randomUUID();
    const actorId = `contract-user-${suffix}`;
    const organizationId = `contract-organization-${suffix}`;

    await database.insert(user).values({
      id: actorId,
      name: "Repository Contract User",
      email: `${actorId}@paca.test`,
      emailVerified: true,
    });
    await database.insert(organization).values({
      id: organizationId,
      name: "Repository Contract Organization",
      slug: organizationId,
      createdAt: new Date(),
    });

    return {
      repository: new PostgresProjectRepository(database),
      organizationId,
      actorId,
      cleanup: async () => {
        try {
          await database.delete(organization).where(eq(organization.id, organizationId));
          await database.delete(user).where(eq(user.id, actorId));
        } finally {
          await client.end();
        }
      },
    };
  });
});
