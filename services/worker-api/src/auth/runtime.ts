import type { AgentSession } from "@better-auth/agent-auth";
import type { BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";
import { organization } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { pacaAgentApprovalGuard } from "../agent-auth/approval-guard";
import { recordAgentAuthEvent } from "../agent-auth/audit";
import { createPostgresPacaAgentExecutor } from "../agent-auth/execution";
import { pacaAgentAuth } from "../agent-auth/plugin";
import { PostgresBetterAuthSecondaryStorage } from "../agent-auth/secondary-storage";
import type { AppBindings } from "../bindings";
import { type PacaDatabase, withDatabase } from "../database";
import * as schema from "../db/schema";
import { pacaPermission } from "../permission/plugin";
import { PostgresPacaPermissionStore } from "../permission/postgres-store";
import { PacaPermissionService } from "../permission/service";
import {
  invalidateProjectActor,
  invalidateProjectSession,
  invalidateUserSession,
} from "../realtime/invalidation";

const MINIMUM_SECRET_LENGTH = 32;
const ONE_DAY_SECONDS = 60 * 60 * 24;
const SESSION_EXPIRES_IN_SECONDS = ONE_DAY_SECONDS * 7;

type AuthDatabase = NonNullable<BetterAuthOptions["database"]>;

export type CurrentUserSession = {
  id: string;
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    image: string | null;
    createdAt: string;
  };
  expiresAt: string;
};

function normalizeConfiguredOrigin(value: string): string {
  const url = new URL(value);
  const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const validProtocol = url.protocol === "https:" || (url.protocol === "http:" && isLocalhost);

  if (
    !validProtocol ||
    url.origin === "null" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("TRUSTED_ORIGIN_INVALID");
  }

  return url.origin;
}

export function readTrustedOrigins(env: AppBindings): string[] {
  const origins = new Set(
    (env.TRUSTED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
      .map(normalizeConfiguredOrigin),
  );

  if (env.BETTER_AUTH_URL) {
    origins.add(normalizeConfiguredOrigin(env.BETTER_AUTH_URL));
  }

  return [...origins];
}

function requireAuthConfiguration(env: AppBindings) {
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < MINIMUM_SECRET_LENGTH) {
    throw new Error("BETTER_AUTH_SECRET_NOT_CONFIGURED");
  }
  if (!env.BETTER_AUTH_URL) {
    throw new Error("BETTER_AUTH_URL_NOT_CONFIGURED");
  }

  const baseURL = new URL(env.BETTER_AUTH_URL);
  if (
    baseURL.origin === "null" ||
    baseURL.username ||
    baseURL.password ||
    baseURL.pathname !== "/" ||
    baseURL.search ||
    baseURL.hash
  ) {
    throw new Error("BETTER_AUTH_URL_INVALID");
  }

  const isLocalhost = baseURL.hostname === "localhost" || baseURL.hostname === "127.0.0.1";
  if (baseURL.protocol !== "https:" && !(baseURL.protocol === "http:" && isLocalhost)) {
    throw new Error("BETTER_AUTH_URL_INSECURE");
  }

  return {
    secret: env.BETTER_AUTH_SECRET,
    baseURL: baseURL.toString().replace(/\/$/, ""),
    secureCookies: baseURL.protocol === "https:",
  };
}

export function createAuthOptions(
  database: AuthDatabase,
  env: AppBindings,
  permissionPlugin: ReturnType<typeof pacaPermission> = pacaPermission(),
  agentAuthPlugin: ReturnType<typeof pacaAgentAuth> = pacaAgentAuth(),
  agentApprovalGuard: ReturnType<typeof pacaAgentApprovalGuard> = pacaAgentApprovalGuard(),
  secondaryStorage?: BetterAuthOptions["secondaryStorage"],
) {
  const configuration = requireAuthConfiguration(env);

  return {
    appName: "Paca",
    secret: configuration.secret,
    baseURL: configuration.baseURL,
    trustedOrigins: readTrustedOrigins(env),
    database,
    secondaryStorage,
    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: ONE_DAY_SECONDS,
      freshAge: ONE_DAY_SECONDS,
      cookieCache: {
        enabled: false,
      },
      // Supplying secondaryStorage must not silently move user sessions out
      // of the authoritative PostgreSQL tables.
      storeSessionInDatabase: true,
    },
    verification: {
      storeInDatabase: true,
    },
    advanced: {
      useSecureCookies: configuration.secureCookies,
      defaultCookieAttributes: {
        httpOnly: true,
        secure: configuration.secureCookies,
        sameSite: "lax",
        path: "/",
      },
      database: {
        joins: true,
      },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
    },
    plugins: [
      organization({
        teams: {
          enabled: false,
        },
      }),
      permissionPlugin,
      agentAuthPlugin,
      agentApprovalGuard,
    ],
  } satisfies BetterAuthOptions;
}

export function createAuth(db: PacaDatabase, env: AppBindings) {
  const database = drizzleAdapter(db, {
    provider: "pg",
    schema,
  });

  const permissionStore = new PostgresPacaPermissionStore(db);
  const permissionPlugin = pacaPermission({
    service: new PacaPermissionService(permissionStore),
    provisionUser: (userId, sessionToken) =>
      permissionStore.provisionDefaultOrganizationUser(userId, sessionToken),
  });

  const agentAuthPlugin = pacaAgentAuth({
    autonomousHostEnrollmentSecret: env.AUTONOMOUS_HOST_ENROLLMENT_SECRET,
    onEvent: (event) => recordAgentAuthEvent(db, event),
    onExecute: createPostgresPacaAgentExecutor(db),
  });
  const agentApprovalGuard = pacaAgentApprovalGuard({
    permissionService: new PacaPermissionService(permissionStore),
    findProjectOrganization: (projectId) => permissionStore.findProjectOrganization(projectId),
    onEvent: (event) => recordAgentAuthEvent(db, event),
    onCapabilitiesRevoked: async ({ agentId, projectIds }) => {
      await Promise.all(
        projectIds.map((projectId) => invalidateProjectActor(env, projectId, "agent", agentId)),
      );
    },
  });
  const secondaryStorage = new PostgresBetterAuthSecondaryStorage(db);

  return betterAuth(
    createAuthOptions(
      database,
      env,
      permissionPlugin,
      agentAuthPlugin,
      agentApprovalGuard,
      secondaryStorage,
    ),
  );
}

export async function handleAuthRequest(request: Request, env: AppBindings): Promise<Response> {
  return withDatabase(env, async (db) => {
    const auth = createAuth(db, env);
    const isSignOut =
      request.method === "POST" && new URL(request.url).pathname === "/api/auth/sign-out";
    const current = isSignOut
      ? await auth.api.getSession({
          headers: request.headers,
          query: { disableCookieCache: true },
        })
      : null;
    const memberships = current
      ? await db
          .select({ projectId: schema.pacaProjectMembers.projectId })
          .from(schema.pacaProjectMembers)
          .where(eq(schema.pacaProjectMembers.userId, current.user.id))
      : [];

    const response = await auth.handler(request);
    if (response.ok && current) {
      await Promise.all([
        invalidateUserSession(env, current.user.id, current.session.id),
        ...memberships.map(({ projectId }) =>
          invalidateProjectSession(env, projectId, current.session.id),
        ),
      ]);
    }
    return response;
  });
}

export async function handleAgentConfigurationRequest(
  _request: Request,
  env: AppBindings,
): Promise<Response> {
  return withDatabase(env, async (db) => {
    const configuration = await createAuth(db, env).api.getAgentConfiguration();
    return Response.json(configuration, {
      headers: { "cache-control": "public, max-age=300" },
    });
  });
}

export async function readCurrentUserSession(
  request: Request,
  env: AppBindings,
): Promise<CurrentUserSession | null> {
  return withDatabase(env, (db) => readCurrentUserSessionFromDatabase(db, request, env));
}

export async function readCurrentAgentSession(
  request: Request,
  env: AppBindings,
): Promise<AgentSession | null> {
  return withDatabase(env, (db) => readCurrentAgentSessionFromDatabase(db, request, env));
}

export async function readCurrentAgentSessionFromDatabase(
  db: PacaDatabase,
  request: Request,
  env: AppBindings,
): Promise<AgentSession | null> {
  return createAuth(db, env).api.getAgentSession({ headers: request.headers });
}

export async function readCurrentUserSessionFromDatabase(
  db: PacaDatabase,
  request: Request,
  env: AppBindings,
): Promise<CurrentUserSession | null> {
  const result = await createAuth(db, env).api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true },
  });

  if (!result) return null;

  return {
    id: result.session.id,
    user: {
      id: result.user.id,
      name: result.user.name,
      email: result.user.email,
      emailVerified: result.user.emailVerified,
      image: result.user.image ?? null,
      createdAt: result.user.createdAt.toISOString(),
    },
    expiresAt: result.session.expiresAt.toISOString(),
  };
}
