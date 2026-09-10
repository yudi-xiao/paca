import { afterEach, describe, expect, it } from "vitest";

import { requireLocalTestDatabase } from "../scripts/lib/postgres-test-database";

const originalDatabaseURL = process.env.PACA_TEST_DATABASE_URL;

afterEach(() => {
  if (originalDatabaseURL === undefined) {
    delete process.env.PACA_TEST_DATABASE_URL;
  } else {
    process.env.PACA_TEST_DATABASE_URL = originalDatabaseURL;
  }
});

describe("PostgreSQL test database guard", () => {
  it("accepts only an explicitly named local test database", () => {
    process.env.PACA_TEST_DATABASE_URL =
      "postgresql://contract:secret@127.0.0.1:5432/paca_worker_test";

    expect(requireLocalTestDatabase()).toEqual({
      connectionString: "postgresql://contract:secret@127.0.0.1:5432/paca_worker_test",
      databaseName: "paca_worker_test",
    });
  });

  it("rejects remote hosts before attempting a connection", () => {
    process.env.PACA_TEST_DATABASE_URL =
      "postgresql://contract:secret@database.example.test:5432/paca_worker_test";

    expect(() => requireLocalTestDatabase()).toThrowError("PACA_TEST_DATABASE_MUST_BE_LOCAL");
  });

  it("rejects a local database without the test suffix", () => {
    process.env.PACA_TEST_DATABASE_URL = "postgresql://contract:secret@localhost:5432/paca";

    expect(() => requireLocalTestDatabase()).toThrowError(
      "PACA_TEST_DATABASE_NAME_MUST_END_IN_TEST",
    );
  });
});
