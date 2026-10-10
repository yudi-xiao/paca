import {
	AgentAuthClient,
	AgentAuthClientError,
	type AgentAuthConfig,
	loadAgentAuthConfig,
} from "./client.js";
import { getAgentCapabilityTools } from "./server.js";

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATES = new Set([
	"active",
	"pending",
	"revoked",
	"expired",
	"rejected",
	"claimed",
	"denied",
	"consumed",
]);
const CAPABILITY = /^[a-z][a-z0-9_.-]{0,127}$/;

export type AgentDoctorReport = {
	status: "connected" | "needs_attention" | "error";
	code: string;
	message: string;
	agentId?: string;
	hostId?: string;
	configuredTools?: string[];
	grants?: { active: number; pending: number; inactive: number };
};

const guidance: Record<string, string> = {
  AGENT_HTTP_401: "Paca rejected this Agent/Host identity. Check that it still exists and is active; re-enroll or restore its matching private configuration, then complete approval in Paca.",
	PACA_AGENT_CONFIG_REQUIRED:
		"Set PACA_AGENT_CONFIG to the private Agent Auth configuration created during registration.",
	PACA_AUTH_MODE_AMBIGUOUS:
		"Use the local Agent Auth configuration by itself; remove API key and Sandbox broker credentials from this process.",
	PACA_AGENT_CONFIG_PERMISSIONS_INVALID:
		"Use a regular private configuration file with mode 0600; symbolic links and group/public access are rejected.",
	PACA_AGENT_CONFIG_INVALID:
		"Register the Agent again or restore its valid private configuration; do not paste credentials into logs.",
	PACA_AGENT_ID_MISMATCH:
		"Use the Agent ID belonging to this configuration or remove PACA_AGENT_ID.",
	PACA_PROJECT_SCOPE_INVALID:
		"Choose a valid project included in this Agent's requested grants.",
	AGENT_NETWORK_UNAVAILABLE:
		"Check the Paca endpoint and network connection, then run the diagnostic again.",
	AGENT_RESPONSE_INVALID:
		"The endpoint returned an unexpected response; check the deployed Paca version and endpoint configuration.",
	PACA_AGENT_PENDING:
		"Complete the Agent approval in Paca, then run the diagnostic again.",
	PACA_AGENT_INACTIVE:
		"This Agent is inactive or expired; check its status in Paca and obtain a new approval if required.",
	PACA_AGENT_GRANTS_UNAVAILABLE:
		"Request and approve scoped capabilities in Paca; pending, revoked and expired grants cannot execute tools.",
};

function object(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function scopeIncludes(value: unknown, projectId: string): boolean {
	if (value === projectId) return true;
	const operator = object(value);
	if (!operator || Object.keys(operator).length !== 1) return false;
	return (
		operator.eq === projectId ||
		(Array.isArray(operator.in) &&
			operator.in.length <= 100 &&
			operator.in.every(
				(value) => typeof value === "string" && UUID.test(value),
			) &&
			operator.in.includes(projectId))
	);
}

function deadline(value: unknown): number | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value))
		return Number.NaN;
	return Date.parse(value);
}

function failure(code: string): AgentDoctorReport {
	return {
		status: "error",
		code,
		message:
			guidance[code] ??
			"Paca rejected the diagnostic request. Check Agent/Host approval and capabilities in Paca; tool authorization is verified again for every request.",
	};
}

/** Only an allowlisted summary leaves this function: no keys, JWTs, grants,
 * payloads, endpoint credentials, task text or remote error messages. */
export async function diagnoseLocalAgent(
	environment: Readonly<Record<string, string | undefined>>,
	dependencies: {
		load?: (path: string) => Promise<AgentAuthConfig>;
		status?: (config: AgentAuthConfig) => Promise<unknown>;
		now?: () => number;
	} = {},
): Promise<AgentDoctorReport> {
	try {
		if (
			[
				"PACA_API_KEY",
				"PACA_CAPABILITY_BROKER_URL",
				"PACA_CAPABILITY_BROKER_TOKEN",
				"PACA_CAPABILITY_BROKER_CONFIG",
			].some((key) => environment[key])
		) {
			throw new AgentAuthClientError("PACA_AUTH_MODE_AMBIGUOUS");
		}
		const path = environment.PACA_AGENT_CONFIG?.trim();
		if (!path) throw new AgentAuthClientError("PACA_AGENT_CONFIG_REQUIRED");
		const config = await (dependencies.load ?? loadAgentAuthConfig)(path);
		if (
			environment.PACA_AGENT_ID &&
			environment.PACA_AGENT_ID !== config.agentId
		) {
			throw new AgentAuthClientError("PACA_AGENT_ID_MISMATCH");
		}
		const project = environment.PACA_PROJECT_ID;
		if (
			project &&
			(!UUID.test(project) ||
				!config.grantRequests.some((request) =>
					scopeIncludes(request.constraints.projectId, project),
				))
		) {
			throw new AgentAuthClientError("PACA_PROJECT_SCOPE_INVALID");
		}
		const now = (dependencies.now ?? Date.now)();
		const status = object(
			await (
				dependencies.status ?? ((value) => new AgentAuthClient(value).status())
			)(config),
		);
		if (
			!status ||
			status.agent_id !== config.agentId ||
			status.host_id !== config.hostId ||
			typeof status.status !== "string" ||
			!STATES.has(status.status) ||
			!Array.isArray(status.agent_capability_grants) ||
			status.agent_capability_grants.length > 128
		) {
			throw new AgentAuthClientError("AGENT_RESPONSE_INVALID");
		}
		const expires = deadline(status.expires_at);
		if (expires !== null && !Number.isFinite(expires))
			throw new AgentAuthClientError("AGENT_RESPONSE_INVALID");
		const grants = { active: 0, pending: 0, inactive: 0 };
		const activeCapabilities = new Set<string>();
		for (const value of status.agent_capability_grants) {
			const grant = object(value);
			if (
				!grant ||
				typeof grant.capability !== "string" ||
				!CAPABILITY.test(grant.capability) ||
				typeof grant.status !== "string" ||
				!STATES.has(grant.status)
			)
				throw new AgentAuthClientError("AGENT_RESPONSE_INVALID");
			if (!config.capabilities.includes(grant.capability)) continue;
			const constraints = object(grant.constraints);
			if (
				project &&
				grant.status === "active" &&
				(!constraints || !scopeIncludes(constraints.projectId, project))
			)
				continue;
			const grantDeadline = deadline(grant.expires_at);
			const scopeDeadline = deadline(constraints?.validUntil);
			const fresh =
				constraints !== null &&
				scopeDeadline !== null &&
				[grantDeadline, scopeDeadline].every(
					(time) => time === null || (Number.isFinite(time) && time > now),
				);
			if (grant.status === "active" && fresh) {
				grants.active++;
				activeCapabilities.add(grant.capability);
			} else if (grant.status === "pending") grants.pending++;
			else grants.inactive++;
		}
		const tools = getAgentCapabilityTools({
			...config,
			capabilities: [...activeCapabilities],
		}).map((tool) => tool.name);
		const code =
			status.status === "pending"
				? "PACA_AGENT_PENDING"
				: status.status !== "active" || (expires !== null && expires <= now)
					? "PACA_AGENT_INACTIVE"
					: grants.active === 0
						? "PACA_AGENT_GRANTS_UNAVAILABLE"
						: "PACA_AGENT_CONNECTED";
		return {
			status: code === "PACA_AGENT_CONNECTED" ? "connected" : "needs_attention",
			code,
			message:
				guidance[code] ??
				"Agent Auth is reachable. Listed tools are configured for active capabilities; each call still checks its current grant, constraints and delegated user permissions. This diagnostic does not claim or execute tasks.",
			agentId: config.agentId,
			hostId: config.hostId,
			configuredTools: code === "PACA_AGENT_CONNECTED" ? tools : [],
			grants,
		};
	} catch (error) {
		return failure(
			error instanceof AgentAuthClientError
				? error.code
				: "PACA_AGENT_DIAGNOSTIC_FAILED",
		);
	}
}
