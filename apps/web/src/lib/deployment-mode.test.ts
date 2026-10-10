import { afterEach, describe, expect, it, vi } from "vitest";
import { allowsTestSignup, usesCloudflareRuntime } from "./deployment-mode";

afterEach(() => vi.unstubAllEnvs());
describe("production deployment mode", () => {
	it("uses the Cloudflare runtime with public registration disabled", () => {
		vi.stubEnv("VITE_PACA_RUNTIME", "cloudflare");
		expect(usesCloudflareRuntime()).toBe(true);
		expect(allowsTestSignup()).toBe(false);
	});
	it("retains runtime selection without enabling registration", () => {
		vi.stubEnv("VITE_PACA_RUNTIME", "");
		expect(usesCloudflareRuntime()).toBe(false);
		expect(allowsTestSignup()).toBe(false);
	});
});
