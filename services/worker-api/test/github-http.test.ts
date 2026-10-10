import { describe, expect, it } from "vitest";
import { githubJson } from "../src/github-delivery/github-http";

describe("safe GitHub failure diagnostics", () => {
  it("records only an operation and status for rejected credentials", async () => {
    const error = await githubJson(
      "/repos/private-owner/private-repo/installation",
      "private-token",
      AbortSignal.timeout(1000),
      async () => Response.json({ message: "remote-sensitive-details" }, { status: 401 }),
    ).catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: "GITHUB_DELIVERY_UNAVAILABLE",
      diagnostic: { operation: "installation", failure: "http", httpStatus: 401 },
    });
    expect(JSON.stringify(error)).not.toMatch(
      /private-owner|private-repo|private-token|remote-sensitive/,
    );
  });
  it.each([
    [
      async () => {
        throw Error("Bearer private-token at secret-url");
      },
      "transport",
    ],
    [async () => new Response("invalid-sensitive-payload"), "response"],
  ] as const)("classifies local fetch and parse failures without retaining raw causes", async (fetch_, failure) => {
    const error = await githubJson(
      "/app/installations/123/access_tokens",
      "private-token",
      AbortSignal.timeout(1000),
      fetch_,
    ).catch((error: unknown) => error);
    expect(error).toMatchObject({ diagnostic: { operation: "token", failure } });
    expect(JSON.stringify(error)).not.toMatch(/private-token|secret-url|sensitive/);
  });
});
