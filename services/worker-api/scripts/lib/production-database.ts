import { Client, type ClientConfig } from "pg";
import * as z from "zod";
import { operatorJson } from "./operator-command";

export const productionDatabase = {
  organization: "463708580",
  database: "paca",
  branch: "prod",
  branchId: "dshooho15033",
  runtimeRoleName: "paca-worker-internal",
  runtimeRole: "pscale_api_m5nnyv00jm5v",
  productionHyperdrive: "ec828e1b80664166ab38aa511cfd1f82",
} as const;

export async function productionCommand(args: string[]): Promise<unknown> {
  return operatorJson("pscale", [
    ...args,
    "--org",
    productionDatabase.organization,
    "--format",
    "json",
  ]);
}

export function parseOperatorRole(payload: unknown): {
  id: string;
  role: string;
  clientConfig: ClientConfig;
} {
  const data = z
    .object({
      id: z.string().regex(/^[a-z0-9]+$/u),
      database_url: z.string(),
      password: z.string().optional(),
    })
    .parse(payload);
  const url = new URL(data.database_url);
  const username = decodeURIComponent(url.username);
  const role = username.split(".")[0] ?? "";
  if (
    !/^postgres(?:ql)?:$/u.test(url.protocol) ||
    !/^pscale_api_[a-z0-9]+$/u.test(role) ||
    username !== `${role}.${productionDatabase.branchId}` ||
    !url.hostname.endsWith(".pg.psdb.cloud") ||
    url.pathname !== "/postgres" ||
    url.port !== "5432"
  )
    throw new Error("PRODUCTION_OPERATOR_ROLE_INVALID");
  const password = decodeURIComponent(url.password) || data.password;
  if (!password) throw new Error("PRODUCTION_OPERATOR_PASSWORD_MISSING");
  // URL sslmode parsing cannot downgrade certificate verification. Credentials
  // stay in memory and never appear in psql arguments or operator output.
  return {
    id: data.id,
    role,
    clientConfig: {
      host: url.hostname,
      port: 5432,
      database: "postgres",
      user: username,
      password,
      ssl: { rejectUnauthorized: true },
      connectionTimeoutMillis: 15_000,
      query_timeout: 30_000,
      statement_timeout: 30_000,
    },
  };
}

export async function withProductionOperator<T>(
  purpose: "verify" | "smoke",
  operation: (client: Client, role: string) => Promise<T>,
): Promise<T> {
  const target = z.object({
    id: z.literal(productionDatabase.branchId),
    name: z.literal(productionDatabase.branch),
    ready: z.literal(true),
  });
  target.parse(await productionCommand(["branch", "show", "paca", productionDatabase.branch]));
  const payload = await productionCommand([
    "role",
    "create",
    "paca",
    productionDatabase.branch,
    `paca-${purpose}-${Date.now()}`,
    "--inherited-roles",
    "postgres",
    "--ttl",
    "15m",
  ]);
  const identity = z.object({ id: z.string().regex(/^[a-z0-9]+$/u) }).parse(payload);
  let client: Client | undefined;
  try {
    const role = parseOperatorRole(payload);
    client = new Client(role.clientConfig);
    await client.connect();
    return await operation(client, role.role);
  } finally {
    await client?.end().catch(() => undefined);
    // Do not swallow cleanup failures: an expired/reassigned operator role is
    // part of completing the operation. CLI errors never include credentials.
    await productionCommand([
      "role",
      "delete",
      "paca",
      productionDatabase.branch,
      identity.id,
      "--successor",
      "postgres",
      "--force",
    ]);
  }
}
