const PREFIX_FLAG = "--paca-env-prefix";
const PREFIX_PATTERN = /^PACA_SESSION_[0-9A-F]{32}$/;

// Only values the Runner intentionally brokers are copied. Treating the
// prefix as a general environment-variable namespace would let an accidental
// or malicious argument rewrite unrelated process configuration.
const BROKERED_PACA_ENV = [
	"PACA_CAPABILITY_BROKER_URL",
	"PACA_CAPABILITY_BROKER_TOKEN",
	"PACA_CAPABILITY_BROKER_CONFIG",
	"PACA_PROJECT_ID",
	"PACA_ACTOR_USER_ID",
	"PACA_REPO_PLUGIN_IDS",
	"PACA_WORKDIR",
] as const;

const AUTH_ENV = [
	"PACA_API_KEY",
	"PACA_AGENT_CONFIG",
	"PACA_CAPABILITY_BROKER_URL",
	"PACA_CAPABILITY_BROKER_TOKEN",
	"PACA_CAPABILITY_BROKER_CONFIG",
] as const;

/**
 * Restores conversation-prefixed Goose secrets to the canonical PACA_* names
 * expected by the MCP implementation. The prefix itself is non-sensitive and
 * may safely travel in session/new metadata; values remain in Goose's secret
 * store until it spawns this process.
 *
 * This must run before importing server.ts because repo-tools.ts intentionally
 * reads PACA_WORKDIR once at module initialization.
 */
export function applyPacaEnvironmentPrefix(
	argv: readonly string[],
	env: NodeJS.ProcessEnv,
): void {
	const flagIndex = argv.indexOf(PREFIX_FLAG);
	if (flagIndex < 0) return;
	const prefix = argv[flagIndex + 1];
	if (!prefix || !PREFIX_PATTERN.test(prefix)) {
		throw new Error("PACA_ENV_PREFIX_INVALID");
	}

	// A static Environment may still carry legacy container-level values from
	// an older deployment. Clear every auth mode first so a brokered process
	// cannot accidentally start with two identities.
	for (const name of AUTH_ENV) delete env[name];
	for (const name of BROKERED_PACA_ENV) {
		const suffix = name.slice("PACA_".length);
		const value = env[`${prefix}_${suffix}`];
		if (value === undefined) delete env[name];
		else env[name] = value;
	}
}
