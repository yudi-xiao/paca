import { randomBytes } from "node:crypto";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";
import { organization } from "better-auth/plugins";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { createAuthOptions } from "../../src/auth/runtime";
import type { AppBindings } from "../../src/bindings";
import * as schema from "../../src/db/schema";
import { pacaPermission } from "../../src/permission/plugin";
import { PostgresPacaPermissionStore } from "../../src/permission/postgres-store";
import { PacaPermissionService } from "../../src/permission/service";
import { withProductionOperator } from "./production-database";
import { ownerInput } from "./production-owner";

const fixtures: { id: string; email: string }[] = [];
const origin = "https://paca.howlearnwood.com";
/** Private fixture provisioning leaves production HTTP signup disabled. */
export const productionSmokeFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  if (request.url !== `${origin}/api/auth/sign-up/email`) return fetch(request);
  if (
    process.env.PACA_PROD_SMOKE_CONFIRM !== "RUN_PACA_PROD_SMOKE" ||
    request.method !== "POST" ||
    request.headers.get("origin") !== origin
  )
    throw new Error("PRODUCTION_SMOKE_AUTH_CONFIRM_REQUIRED");
  const credential = ownerInput.parse(await request.json());
  if (!/^[a-z0-9-]*smoke[a-z0-9-]*@paca\.test$/u.test(credential.email))
    throw new Error("PRODUCTION_SMOKE_FIXTURE_EMAIL_REQUIRED");
  await withProductionOperator("smoke", async (client) => {
    const db = drizzle(client, { schema });
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(1885432671)`);
      const owner = await tx.execute(
        sql`select 1 from paca_user_system_role assignment join paca_system_role role on role.id = assignment.role_id where role.name = 'SUPER_ADMIN' and role.is_built_in = true limit 1`,
      );
      if (owner.rows.length !== 1) throw new Error("PRODUCTION_SMOKE_REAL_OWNER_REQUIRED");
      const store = new PostgresPacaPermissionStore(tx);
      const plugin = pacaPermission({
        service: new PacaPermissionService(store),
        provisionUser: (id, token) => store.provisionDefaultOrganizationUser(id, token),
      });
      const options = createAuthOptions(
        drizzleAdapter(tx, { provider: "pg", schema }),
        {
          ENVIRONMENT: "prod",
          BETTER_AUTH_SECRET: randomBytes(48).toString("hex"),
          BETTER_AUTH_URL: origin,
          TRUSTED_ORIGINS: origin,
        } as AppBindings,
        plugin,
      );
      const auth = betterAuth({
        ...options,
        plugins: [organization({ teams: { enabled: false } }), plugin],
        emailAndPassword: { ...options.emailAndPassword, disableSignUp: false },
        logger: { disabled: true },
      });
      const created = await auth.api.signUpEmail({ body: credential, asResponse: true });
      if (!created.ok) throw new Error("PRODUCTION_SMOKE_FIXTURE_CREATE_FAILED");
      const result = (await created.json()) as { user: { id: string } };
      await tx.delete(schema.session).where(eq(schema.session.userId, result.user.id));
      fixtures.push({ id: result.user.id, email: credential.email });
    });
  });
  // Only the actual prod login can issue a browser session cookie.
  return fetch(`${origin}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      email: credential.email,
      password: credential.password,
      rememberMe: false,
    }),
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
  });
};
export async function cleanupProductionSmokeUsers(): Promise<void> {
  if (fixtures.length === 0) return;
  await withProductionOperator("smoke", async (client) => {
    for (const fixture of fixtures)
      await client.query('delete from "user" where id=$1 and email=$2', [
        fixture.id,
        fixture.email,
      ]);
  });
  fixtures.length = 0;
}
