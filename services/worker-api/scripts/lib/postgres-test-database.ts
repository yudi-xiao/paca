const localHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export type LocalTestDatabase = {
  connectionString: string;
  databaseName: string;
};

export function requireLocalTestDatabase(): LocalTestDatabase {
  const connectionString = process.env.PACA_TEST_DATABASE_URL?.trim();
  if (!connectionString) throw new Error("PACA_TEST_DATABASE_URL_REQUIRED");

  const parsedURL = new URL(connectionString);
  if (!/^postgres(?:ql)?:$/u.test(parsedURL.protocol)) {
    throw new Error("PACA_TEST_DATABASE_URL_INVALID");
  }

  const databaseName = decodeURIComponent(parsedURL.pathname.slice(1));
  if (!/^[a-z0-9_]+_test$/u.test(databaseName)) {
    throw new Error("PACA_TEST_DATABASE_NAME_MUST_END_IN_TEST");
  }
  if (!localHosts.has(parsedURL.hostname)) {
    throw new Error("PACA_TEST_DATABASE_MUST_BE_LOCAL");
  }

  return { connectionString, databaseName };
}
