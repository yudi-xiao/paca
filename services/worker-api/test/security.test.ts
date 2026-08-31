import { describe, expect, it } from "vitest";

import { constantTimeEqual, readBearerToken } from "../src/security";

describe("security helpers", () => {
  it("compares tokens by digest", async () => {
    await expect(constantTimeEqual("same-token", "same-token")).resolves.toBe(true);
    await expect(constantTimeEqual("same-token", "different-token")).resolves.toBe(false);
  });

  it("accepts one bearer token and rejects malformed authorization", () => {
    expect(readBearerToken("Bearer token-value")).toBe("token-value");
    expect(readBearerToken("bearer token-value")).toBe("token-value");
    expect(readBearerToken("Basic token-value")).toBeNull();
    expect(readBearerToken("Bearer one two")).toBeNull();
    expect(readBearerToken(undefined)).toBeNull();
  });
});
