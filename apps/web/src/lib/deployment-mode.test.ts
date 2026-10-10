import { afterEach, describe, expect, it, vi } from "vitest";
import {
	allowsInternalTestSignup,
	usesCloudflareRuntime,
} from "./deployment-mode";

afterEach(() => vi.unstubAllEnvs());

describe("Cloudflare deployment mode", () => {
	it("keeps native functionality while production test signup is disabled", () => {
		vi.stubEnv("VITE_PACA_RUNTIME", "cloudflare");
		vi.stubEnv("VITE_INTERNAL_PREVIEW", "false");
		expect(usesCloudflareRuntime()).toBe(true);
		expect(allowsInternalTestSignup()).toBe(false);
	});

	it("exposes test signup only in the explicitly enabled Cloudflare preview", () => {
		vi.stubEnv("VITE_PACA_RUNTIME", "cloudflare");
		vi.stubEnv("VITE_INTERNAL_PREVIEW", "true");
		expect(usesCloudflareRuntime()).toBe(true);
		expect(allowsInternalTestSignup()).toBe(true);
	});

	it("does not use the preview signup switch to select a runtime", () => {
		vi.stubEnv("VITE_PACA_RUNTIME", "");
		vi.stubEnv("VITE_INTERNAL_PREVIEW", "true");
		expect(usesCloudflareRuntime()).toBe(false);
		expect(allowsInternalTestSignup()).toBe(false);
	});
});
