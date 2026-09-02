import { queryOptions } from "@tanstack/react-query";

type JsonRecord = Record<string, unknown>;

export type AgentAuthGrant = {
	capability: string;
	status: "active" | "pending" | "denied" | "revoked" | string;
	constraints?: JsonRecord;
	expires_at?: string;
	reason?: string;
};

export type AgentAuthAgent = {
	agent_id: string;
	name: string;
	status: "pending" | "active" | "revoked" | "expired" | "rejected" | "claimed";
	mode: "delegated" | "autonomous";
	host_id: string;
	host_name: string;
	agent_capability_grants: AgentAuthGrant[];
	created_at: string;
	last_used_at: string | null;
	expires_at: string | null;
};

export type AgentAuthHost = {
	id: string;
	name: string;
	status: "pending" | "active" | "revoked" | "rejected" | "pending_enrollment";
	default_capabilities: string[];
	activated_at: string | null;
	expires_at: string | null;
	last_used_at: string | null;
	created_at: string;
	updated_at: string;
};

export type AgentAuthHostEnrollment = {
	hostId: string;
	status: string;
	default_capabilities: string[];
	enrollmentToken?: string;
	enrollmentTokenExpiresAt?: string;
};

export type AgentHostRuntimeProfile = {
	host_id: string;
	host_name: string | null;
	host_status: string;
	approved_labels: string[];
	reported_labels: string[];
	reported_harness_kinds: string[];
	effective_labels: string[];
	labels_version: number;
	approved_by: string | null;
	approved_at: string | null;
	last_heartbeat_at: string | null;
	heartbeat_expires_at: string | null;
	online: boolean;
	created_at: string;
	updated_at: string;
};

export type AgentAuthConfiguration = {
	modes: Array<"delegated" | "autonomous">;
};

export class AgentAuthApiError extends Error {
	readonly status: number;
	readonly code: string | null;

	constructor(status: number, code: string | null) {
		super(code ?? `AGENT_AUTH_HTTP_${status}`);
		this.name = "AgentAuthApiError";
		this.status = status;
		this.code = code;
	}
}

function asRecord(value: unknown): JsonRecord | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonRecord)
		: null;
}

const semanticApprovalErrors = new Set([
	"fresh_session_required",
	"invalid_user_code",
	"approval_expired",
	"capability_request_already_resolved",
	"capability_request_owner_mismatch",
	"agent_not_found",
]);

function agentAuthErrorCode(value: unknown): string | null {
	const record = asRecord(value);
	const candidates = [record?.error, record?.message, record?.code].filter(
		(candidate): candidate is string => typeof candidate === "string",
	);
	return (
		candidates.find(
			(candidate) =>
				candidate.startsWith("AGENT_APPROVAL_") ||
				semanticApprovalErrors.has(candidate.toLowerCase()),
		) ??
		candidates.at(-1) ??
		null
	);
}

async function agentAuthRequest(path: string, init: RequestInit = {}) {
	const headers = new Headers(init.headers);
	if (init.body !== undefined) headers.set("content-type", "application/json");
	const response = await fetch(`/api/auth${path}`, {
		...init,
		credentials: "include",
		headers,
	});
	const contentType = response.headers.get("content-type") ?? "";
	const body = contentType.includes("application/json")
		? await response.json()
		: null;
	if (!response.ok) {
		throw new AgentAuthApiError(response.status, agentAuthErrorCode(body));
	}
	return body;
}

async function pacaAgentRequest(path: string, init: RequestInit = {}) {
	const headers = new Headers(init.headers);
	if (init.body !== undefined) headers.set("content-type", "application/json");
	const response = await fetch(`/api/v1/agent${path}`, {
		...init,
		credentials: "include",
		headers,
	});
	const body = asRecord(await response.json().catch(() => null));
	if (!response.ok) {
		throw new AgentAuthApiError(response.status, agentAuthErrorCode(body));
	}
	return body;
}

export async function getAgentAuthConfiguration(): Promise<AgentAuthConfiguration> {
	const response = await fetch("/.well-known/agent-configuration", {
		credentials: "include",
	});
	if (!response.ok) throw new AgentAuthApiError(response.status, null);
	const body = asRecord(await response.json());
	return {
		modes: Array.isArray(body?.modes)
			? body.modes.filter(
					(mode): mode is "delegated" | "autonomous" =>
						mode === "delegated" || mode === "autonomous",
				)
			: [],
	};
}

export async function listAgentAuthAgents(): Promise<AgentAuthAgent[]> {
	const body = asRecord(await agentAuthRequest("/agent/list"));
	return Array.isArray(body?.agents) ? (body.agents as AgentAuthAgent[]) : [];
}

export async function listAgentAuthHosts(): Promise<AgentAuthHost[]> {
	const body = asRecord(await agentAuthRequest("/host/list"));
	return Array.isArray(body?.hosts) ? (body.hosts as AgentAuthHost[]) : [];
}

export async function createAgentAuthHost(
	name: string,
): Promise<AgentAuthHostEnrollment> {
	return (await agentAuthRequest("/host/create", {
		method: "POST",
		body: JSON.stringify({ name }),
	})) as AgentAuthHostEnrollment;
}

export async function revokeAgentAuthHost(hostId: string): Promise<void> {
	await agentAuthRequest("/host/revoke", {
		method: "POST",
		body: JSON.stringify({ host_id: hostId }),
	});
}

export async function listAgentHostRuntimes(): Promise<
	AgentHostRuntimeProfile[]
> {
	const body = asRecord(await pacaAgentRequest("/hosts/runtime"));
	return Array.isArray(body?.data)
		? (body.data as AgentHostRuntimeProfile[])
		: [];
}

export async function approveAgentHostLabels(input: {
	hostId: string;
	approvedLabels: string[];
}): Promise<AgentHostRuntimeProfile> {
	const body = asRecord(
		await pacaAgentRequest(
			`/hosts/${encodeURIComponent(input.hostId)}/runtime`,
			{
				method: "PUT",
				body: JSON.stringify({ approved_labels: input.approvedLabels }),
			},
		),
	);
	const data = asRecord(body?.data);
	if (!data)
		throw new AgentAuthApiError(502, "AGENT_HOST_RUNTIME_RESPONSE_INVALID");
	return data as AgentHostRuntimeProfile;
}

export async function grantAutonomousProjectRead(input: {
	agentId: string;
	projectId: string;
	organizationId?: string;
}): Promise<void> {
	const validUntil = new Date(Date.now() + 15 * 60_000).toISOString();
	await agentAuthRequest("/agent/grant-capability", {
		method: "POST",
		body: JSON.stringify({
			agent_id: input.agentId,
			capabilities: [
				{
					name: "project.read",
					constraints: {
						organizationId: input.organizationId ?? "paca-default",
						projectId: input.projectId,
						validUntil,
					},
				},
			],
			ttl: 15 * 60,
		}),
	});
}

export async function revokeAutonomousProjectRead(
	agentId: string,
): Promise<void> {
	await agentAuthRequest("/paca-agent/revoke-capability", {
		method: "POST",
		body: JSON.stringify({
			agent_id: agentId,
			capabilities: ["project.read"],
		}),
	});
}

export async function resolveAgentAuthorization(input: {
	agentId: string;
	userCode?: string;
	action: "approve" | "deny";
}): Promise<void> {
	await agentAuthRequest("/agent/approve-capability", {
		method: "POST",
		body: JSON.stringify({
			agent_id: input.agentId,
			user_code: input.userCode || undefined,
			action: input.action,
		}),
	});
}

export async function reauthenticateAndApproveAgent(input: {
	email: string;
	password: string;
	agentId: string;
	userCode: string;
}): Promise<void> {
	await agentAuthRequest("/sign-in/email", {
		method: "POST",
		body: JSON.stringify({
			email: input.email,
			password: input.password,
			rememberMe: false,
		}),
	});
	await resolveAgentAuthorization({
		agentId: input.agentId,
		userCode: input.userCode,
		action: "approve",
	});
}

export async function revokeAgentAuthAgent(agentId: string): Promise<void> {
	await agentAuthRequest("/agent/revoke", {
		method: "POST",
		body: JSON.stringify({ agent_id: agentId }),
	});
}

export const agentAuthAgentsQueryOptions = queryOptions({
	queryKey: ["agent-auth", "agents"],
	queryFn: listAgentAuthAgents,
	staleTime: 15_000,
});

export const agentAuthHostsQueryOptions = queryOptions({
	queryKey: ["agent-auth", "hosts"],
	queryFn: listAgentAuthHosts,
	staleTime: 15_000,
});

export const agentHostRuntimesQueryOptions = queryOptions({
	queryKey: ["agent-auth", "host-runtimes"],
	queryFn: listAgentHostRuntimes,
	staleTime: 15_000,
});

export const agentAuthConfigurationQueryOptions = queryOptions({
	queryKey: ["agent-auth", "configuration"],
	queryFn: getAgentAuthConfiguration,
	staleTime: 5 * 60_000,
});
