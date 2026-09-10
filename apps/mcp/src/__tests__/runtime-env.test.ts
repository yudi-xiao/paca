import { describe, expect, it } from "vitest";
import { applyPacaEnvironmentPrefix } from "../runtime-env.js";

const prefix = "PACA_SESSION_0123456789ABCDEF0123456789ABCDEF";

describe("applyPacaEnvironmentPrefix", () => {
	it("maps only the conversation namespace and clears inherited auth", () => {
		const env: NodeJS.ProcessEnv = {
			PACA_API_KEY: "legacy-key",
			PACA_AGENT_CONFIG: "/legacy/agent.json",
			PACA_CAPABILITY_BROKER_TOKEN: "stale-token",
			[`${prefix}_CAPABILITY_BROKER_URL`]: "http://runner/agent-capabilities",
			[`${prefix}_CAPABILITY_BROKER_TOKEN`]: "fresh-token",
			[`${prefix}_CAPABILITY_BROKER_CONFIG`]: "public-config",
			[`${prefix}_PROJECT_ID`]: "project-1",
			[`${prefix}_WORKDIR`]: "/workspace/demo",
		};

		applyPacaEnvironmentPrefix(
			["node", "paca", "--paca-env-prefix", prefix],
			env,
		);

		expect(env.PACA_API_KEY).toBeUndefined();
		expect(env.PACA_AGENT_CONFIG).toBeUndefined();
		expect(env.PACA_CAPABILITY_BROKER_URL).toBe(
			"http://runner/agent-capabilities",
		);
		expect(env.PACA_CAPABILITY_BROKER_TOKEN).toBe("fresh-token");
		expect(env.PACA_CAPABILITY_BROKER_CONFIG).toBe("public-config");
		expect(env.PACA_PROJECT_ID).toBe("project-1");
		expect(env.PACA_WORKDIR).toBe("/workspace/demo");
	});

	it("rejects an untrusted prefix shape", () => {
		expect(() =>
			applyPacaEnvironmentPrefix(
				["node", "paca", "--paca-env-prefix", "PACA_SESSION_bad"],
				{},
			),
		).toThrow("PACA_ENV_PREFIX_INVALID");
	});

	it("is a no-op without the runner flag", () => {
		const env: NodeJS.ProcessEnv = { PACA_API_KEY: "legacy-key" };
		applyPacaEnvironmentPrefix(["node", "paca"], env);
		expect(env).toEqual({ PACA_API_KEY: "legacy-key" });
	});
});
