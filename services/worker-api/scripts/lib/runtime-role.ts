import { readFile } from "node:fs/promises";
import type { Client } from "pg";

function requireRole(role: string): string {
  if (!/^pscale_api_[a-z0-9]+$/u.test(role)) throw new Error("RUNTIME_DATABASE_ROLE_INVALID");
  return role;
}

// Reuse the reviewed psql files, keeping the authoritative table lists in one
// place. Only these fixed templates and a validated identifier are accepted.
export async function grantRuntimeRole(client: Pick<Client, "query">, role: string): Promise<void> {
  requireRole(role);
  const template = await readFile(
    new URL("../sql/grant-runtime-role.sql", import.meta.url),
    "utf8",
  );
  const match = /\nBEGIN;([\s\S]+)\nCOMMIT;\s*$/u.exec(template);
  if (!match?.[1]) throw new Error("RUNTIME_GRANT_TEMPLATE_INVALID");
  const sql = match[1].replaceAll(':"runtime_role"', `"${role}"`);
  if (sql.includes("\\") || sql.includes(':"runtime_role"'))
    throw new Error("RUNTIME_GRANT_TEMPLATE_INVALID");
  await client.query(sql);
}

export async function verifyRuntimeRole(
  client: Pick<Client, "query">,
  role: string,
): Promise<void> {
  requireRole(role);
  const template = await readFile(
    new URL("../sql/verify-runtime-role.sql", import.meta.url),
    "utf8",
  );
  const crud = /(WITH application_tables[\s\S]+?)\n\\gset/u.exec(template)?.[1];
  const boundary = /\\gset\s+(SELECT [\s\S]+?)\n\\gset/u.exec(template)?.[1];
  if (!crud || !boundary) throw new Error("RUNTIME_VERIFY_TEMPLATE_INVALID");
  for (const [query, resultKey] of [
    [crud, "crud_is_valid"],
    [boundary, "boundary_is_valid"],
  ] as const) {
    const result = await client.query<Record<string, boolean>>(
      query.replaceAll(":'runtime_role'", `'${role}'`),
    );
    if (result.rows.length !== 1 || result.rows[0]?.[resultKey] !== true) {
      throw new Error("RUNTIME_ROLE_PRIVILEGES_INVALID");
    }
  }
}
