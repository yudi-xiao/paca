import { vi } from "vitest";

// Runtime orchestration tests replace each database step using the Workflows
// introspector. SQL behavior is verified separately by PostgreSQL contracts.
vi.mock("../../src/database", () => ({
  withDatabase: () => {
    throw new Error("TEST_DATABASE_STEP_NOT_MOCKED");
  },
}));
