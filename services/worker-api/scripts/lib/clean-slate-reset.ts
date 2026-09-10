export const CLEAN_SLATE_RESET_CONFIRMATION = "RESET_PACA_INTERNAL_DATABASE";

const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/u;
const PLANETSCALE_DATABASE_ROLE = /^pscale_api_[a-z0-9]+$/u;

export type CleanSlateResetConfiguration = {
  organization: string;
  database: string;
  branch: "internal";
  runtimeRoleName: string;
};

function requireSafeName(value: string | undefined, code: string): string {
  const normalized = value?.trim();
  if (!normalized || !SAFE_NAME.test(normalized)) throw new Error(code);
  return normalized;
}

export function parseCleanSlateResetConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): CleanSlateResetConfiguration {
  if (environment.PACA_RESET_INTERNAL_CONFIRM !== CLEAN_SLATE_RESET_CONFIRMATION) {
    throw new Error(`PACA_RESET_INTERNAL_CONFIRM must equal ${CLEAN_SLATE_RESET_CONFIRMATION}`);
  }

  const organization = requireSafeName(
    environment.PACA_PLANETSCALE_ORG,
    "PACA_PLANETSCALE_ORG_REQUIRED",
  );
  const database = requireSafeName(
    environment.PACA_PLANETSCALE_DATABASE?.trim() || "paca",
    "PACA_PLANETSCALE_DATABASE_INVALID",
  );
  const branch = requireSafeName(
    environment.PACA_PLANETSCALE_TARGET_BRANCH?.trim() || "internal",
    "PACA_PLANETSCALE_TARGET_BRANCH_INVALID",
  );
  if (branch !== "internal") throw new Error("TARGET_BRANCH_MUST_BE_INTERNAL");
  const runtimeRoleName = requireSafeName(
    environment.PACA_PLANETSCALE_RUNTIME_ROLE_NAME?.trim() || "paca-worker-internal",
    "PACA_PLANETSCALE_RUNTIME_ROLE_NAME_INVALID",
  );

  return { organization, database, branch, runtimeRoleName };
}

export function selectCleanSlateMigrationFiles(fileNames: string[]): string[] {
  const migrations = fileNames
    .filter((name) => MIGRATION_FILE.test(name))
    .sort((left, right) => left.localeCompare(right));
  if (migrations.length === 0) throw new Error("PACA_RESET_MIGRATIONS_MISSING");

  migrations.forEach((name, expectedIndex) => {
    const match = MIGRATION_FILE.exec(name);
    if (!match || Number(match[1]) !== expectedIndex) {
      throw new Error("PACA_RESET_MIGRATION_SEQUENCE_INVALID");
    }
  });
  return migrations;
}

export function buildCleanSlateSchemaResetSQL(databaseRole: string): string {
  if (!PLANETSCALE_DATABASE_ROLE.test(databaseRole)) {
    throw new Error("TEMP_MIGRATION_DATABASE_ROLE_INVALID");
  }

  return [
    "set role postgres",
    "drop schema public cascade",
    "reset role",
    `create schema public authorization "${databaseRole}"`,
    "revoke create on schema public from public",
  ].join("; ");
}
