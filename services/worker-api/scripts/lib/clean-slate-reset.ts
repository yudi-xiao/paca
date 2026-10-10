const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/u;

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
