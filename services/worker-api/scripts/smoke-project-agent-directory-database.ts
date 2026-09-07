import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import * as z from "zod";

import { PostgresProjectAgentDirectoryRepository } from "../src/agent-directory/postgres-repository";
import { ProjectAgentDirectoryService } from "../src/agent-directory/service";
import * as schema from "../src/db/schema";

const input = z
  .object({
    databaseUrl: z.url(),
    projectId: z.uuid(),
  })
  .parse({
    databaseUrl: process.env.PACA_SMOKE_DATABASE_URL,
    projectId: process.env.PACA_SMOKE_PROJECT_ID,
  });

const connectionUrl = new URL(input.databaseUrl);
connectionUrl.searchParams.delete("sslrootcert");
connectionUrl.searchParams.delete("sslmode");

const client = new Client({
  connectionString: connectionUrl.toString(),
  connectionTimeoutMillis: 8_000,
  query_timeout: 8_000,
  ssl: { rejectUnauthorized: true },
});

await client.connect();
try {
  const directory = await new ProjectAgentDirectoryService(
    new PostgresProjectAgentDirectoryRepository(drizzle(client, { schema })),
  ).list(input.projectId);
  if (directory.length === 0) {
    throw new Error("PROJECT_AGENT_DIRECTORY_SMOKE_REQUIRES_SCOPED_AGENT_HISTORY");
  }
  if (
    directory.some(
      (item) =>
        !item.agentId ||
        !item.hostId ||
        item.capabilityGrants.length === 0 ||
        item.capabilityGrants.some((grant) => !grant.capability),
    )
  ) {
    throw new Error("PROJECT_AGENT_DIRECTORY_SMOKE_RESULT_INVALID");
  }

  console.log(
    JSON.stringify({
      status: "ok",
      step: "project-agent-directory-database-smoke",
      agents: directory.length,
      active: directory.filter(({ authorizationStatus }) => authorizationStatus === "active")
        .length,
      pending: directory.filter(({ authorizationStatus }) => authorizationStatus === "pending")
        .length,
      inactive: directory.filter(({ authorizationStatus }) => authorizationStatus === "inactive")
        .length,
    }),
  );
} finally {
  await client.end();
}
