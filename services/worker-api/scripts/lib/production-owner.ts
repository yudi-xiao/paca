import { randomBytes } from "node:crypto";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";
import { organization } from "better-auth/plugins";
import { count, eq, sql } from "drizzle-orm";
import * as z from "zod";
import { createAuthOptions } from "../../src/auth/runtime";
import type { AppBindings } from "../../src/bindings";
import type { PacaDatabase } from "../../src/database";
import * as schema from "../../src/db/schema";
import { pacaPermission } from "../../src/permission/plugin";
import { PostgresPacaPermissionStore } from "../../src/permission/postgres-store";
import { PacaPermissionService } from "../../src/permission/service";

export const ownerInput = z.object({
  email: z
    .email()
    .max(254)
    .transform((value) => value.trim().toLowerCase()),
  name: z.string().trim().min(1).max(80),
  password: z.string().min(12).max(128),
});

/** Operator-only first-owner flow. No HTTP signup endpoint is mounted, and
 * production's public disableSignUp remains unchanged. The outer Drizzle
 * transaction includes Better Auth credential creation, canonical permission
 * provisioning, verification and immediate bootstrap-session revocation. */
export async function createProductionOwner(
  db: PacaDatabase,
  input: z.input<typeof ownerInput>,
): Promise<void> {
  const credential = ownerInput.parse(input);
  await db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(1885432671)`);
    const [users] = await transaction.select({ value: count() }).from(schema.user);
    const [assignments] = await transaction
      .select({ value: count() })
      .from(schema.pacaUserSystemRoles);
    if (users?.value !== 0 || assignments?.value !== 0)
      throw new Error("PRODUCTION_OWNER_ALREADY_INITIALIZED");
    // The transaction supports nested transactions via savepoints, so the
    // existing permission provisioner can retain its own atomic boundary.
    const permissionStore = new PostgresPacaPermissionStore(transaction as unknown as PacaDatabase);
    const permissionPlugin = pacaPermission({
      service: new PacaPermissionService(permissionStore),
      provisionUser: (userId, sessionToken) =>
        permissionStore.provisionDefaultOrganizationUser(userId, sessionToken),
    });
    const options = createAuthOptions(
      drizzleAdapter(transaction, { provider: "pg", schema }),
      {
        ENVIRONMENT: "prod",
        BETTER_AUTH_SECRET: randomBytes(48).toString("hex"),
        BETTER_AUTH_URL: "https://paca.howlearnwood.com",
        TRUSTED_ORIGINS: "https://paca.howlearnwood.com",
      } as AppBindings,
      permissionPlugin,
    );
    const auth = betterAuth({
      ...options,
      // Only core user and Paca permission behavior is needed by this private
      // process; Agent maintenance is owned by the deployed Worker.
      plugins: [organization({ teams: { enabled: false } }), permissionPlugin],
      emailAndPassword: { ...options.emailAndPassword, disableSignUp: false },
      logger: { disabled: true },
    });
    const response = await auth.api.signUpEmail({ body: credential, asResponse: true });
    if (!response.ok) throw new Error("PRODUCTION_OWNER_CREATION_FAILED");
    const body = z.object({ user: z.object({ id: z.string() }) }).parse(await response.json());
    const owner = await transaction
      .select({
        systemRole: schema.pacaSystemRoles.name,
        organizationRole: schema.pacaOrganizationRoles.name,
        memberRole: schema.member.role,
      })
      .from(schema.pacaUserSystemRoles)
      .innerJoin(
        schema.pacaSystemRoles,
        eq(schema.pacaUserSystemRoles.roleId, schema.pacaSystemRoles.id),
      )
      .innerJoin(schema.member, eq(schema.pacaUserSystemRoles.userId, schema.member.userId))
      .innerJoin(
        schema.pacaOrganizationMemberRoles,
        eq(schema.member.id, schema.pacaOrganizationMemberRoles.memberId),
      )
      .innerJoin(
        schema.pacaOrganizationRoles,
        eq(schema.pacaOrganizationMemberRoles.roleId, schema.pacaOrganizationRoles.id),
      )
      .where(eq(schema.pacaUserSystemRoles.userId, body.user.id));
    if (
      owner.length !== 1 ||
      owner[0]?.systemRole !== "SUPER_ADMIN" ||
      owner[0]?.organizationRole !== "OWNER" ||
      owner[0]?.memberRole !== "owner"
    )
      throw new Error("PRODUCTION_OWNER_ROLES_INVALID");
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const signOut = await auth.api.signOut({ headers: new Headers({ cookie }), asResponse: true });
    if (!signOut.ok) throw new Error("PRODUCTION_BOOTSTRAP_SESSION_REVOCATION_FAILED");
    const [sessions] = await transaction.select({ value: count() }).from(schema.session);
    if (sessions?.value !== 0) throw new Error("PRODUCTION_BOOTSTRAP_SESSION_NOT_REVOKED");
  });
}
