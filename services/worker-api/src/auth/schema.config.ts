import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";
import { organization } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { pacaAgentApprovalGuard } from "../agent-auth/approval-guard";
import { pacaAgentAuth } from "../agent-auth/plugin";
import * as schema from "../db/schema";
import { pacaPermission } from "../permission/plugin";

// Better Auth's schema generator needs a Drizzle adapter instance but does not
// connect to the database. Keep this configuration isolated from the runtime
// factory so schema generation can never consume a Worker binding or a secret.
const schemaClient = new Client({
  connectionString: "postgresql://schema:generator@127.0.0.1:5432/paca",
});

export const auth = betterAuth({
  appName: "Paca",
  database: drizzleAdapter(drizzle(schemaClient, { schema }), {
    provider: "pg",
    schema,
  }),
  emailAndPassword: {
    enabled: true,
  },
  plugins: [
    organization({
      teams: {
        enabled: false,
      },
    }),
    pacaPermission(),
    pacaAgentAuth(),
    pacaAgentApprovalGuard(),
  ],
});
