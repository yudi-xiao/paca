import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { apiClient } from "./api-client";
import type { SuccessEnvelope } from "./api-error";

export function deliveryErrorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object" || !("response" in error))
		return undefined;
	const response = error.response;
	if (!response || typeof response !== "object" || !("data" in response))
		return undefined;
	const data = response.data;
	return data &&
		typeof data === "object" &&
		"error_code" in data &&
		typeof data.error_code === "string"
		? data.error_code
		: undefined;
}
export function deliveryOutcomeUncertain(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("response" in error))
		return true;
	const response = error.response;
	return (
		!response ||
		typeof response !== "object" ||
		!("status" in response) ||
		typeof response.status !== "number" ||
		response.status >= 500
	);
}

export type DeliveryPolicy = {
	owner: string;
	repository: string;
	requiredChecks: { name: string; appId: number }[];
	maxCheckAgeSeconds: number;
	requiredApprovals: number;
	reviewerIds: number[];
};
export type DeliveryRepository = {
	projectId: string;
	repositoryId: number;
	installationId: number;
	policy: DeliveryPolicy;
	version: number;
	status: "active" | "revoked";
	updatedAt: string;
};
export type DeliveryState =
	| "awaiting_acceptance"
	| "waiting"
	| "needs_changes"
	| "stale"
	| "unavailable"
	| "accepted";
export type TaskDelivery = {
	id: string;
	projectId: string;
	taskId: string;
	leaseId: string;
	repositoryId: number;
	policyVersion: number;
	version: number;
	reference: { pullNumber: number; headSha: string };
	state: DeliveryState;
	requiresRefresh: boolean;
	acceptedBy: string | null;
	acceptedAt: string | null;
	requestedChangesBy: string | null;
	requestedChangesAt: string | null;
	reviewNote: string;
	updatedAt: string;
	lastAcceptance: { actorId: string | null; at: string } | null;
	evidence: {
		repository: string;
		pullNumber: number;
		headSha: string;
		pullUrl: string;
		observedAt: string;
		state: Exclude<DeliveryState, "accepted">;
		reasons: string[];
		approvalCount: number;
		checks: {
			name: string;
			appId: number;
			runId: number | null;
			state: "passed" | "pending" | "failed" | "missing" | "stale";
		}[];
	};
};
export type CompletedDeliveryRuns = {
	items: { leaseId: string; harnessKind: string; finishedAt: string }[];
	nextCursor: string | null;
};
export type RepositoryDiscoveryInput = {
	owner: string;
	repository: string;
	pullNumber: number;
	reviewerLogins?: string[];
	reviewerIds?: number[];
};
export type RepositoryDiscovery = {
	owner: string;
	repository: string;
	repositoryId: number;
	installationId: number;
	pullNumber: number;
	headSha: string;
	observedAt: string;
	checks: {
		name: string;
		appId: number;
		appName: string | null;
		appSlug: string | null;
	}[];
	reviewers: { id: number; login: string }[];
};
export type DeliveryRepositoryCommand = {
	requestId: string;
	expectedVersion: number;
	repositoryId: number;
	installationId: number;
	policy: DeliveryPolicy;
};
export async function discoverDeliveryRepository(
	projectId: string,
	input: RepositoryDiscoveryInput,
): Promise<RepositoryDiscovery> {
	return (
		await apiClient.instance.post<SuccessEnvelope<RepositoryDiscovery>>(
			`/projects/${projectId}/github-repository/discover`,
			input,
		)
	).data.data;
}
export async function configureDeliveryRepository(
	projectId: string,
	input: DeliveryRepositoryCommand,
): Promise<DeliveryRepository> {
	return (
		await apiClient.instance.put<SuccessEnvelope<DeliveryRepository>>(
			`/projects/${projectId}/github-repository`,
			input,
		)
	).data.data;
}
const path = (projectId: string, taskId: string) =>
	`/projects/${projectId}/tasks/${taskId}/delivery`;
const fresh = { staleTime: 0, gcTime: 0, retry: false as const };
export function deliveryRepositoryQueryOptions(projectId: string) {
	return queryOptions({
		queryKey: ["projects", projectId, "github-repository"],
		queryFn: async ({ signal }) =>
			(
				await apiClient.instance.get<
					SuccessEnvelope<DeliveryRepository | null>
				>(`/projects/${projectId}/github-repository`, { signal })
			).data.data,
		...fresh,
	});
}
export function taskDeliveryQueryOptions(projectId: string, taskId: string) {
	return queryOptions({
		queryKey: ["projects", projectId, "tasks", taskId, "delivery"],
		queryFn: async ({ signal }) =>
			(
				await apiClient.instance.get<SuccessEnvelope<TaskDelivery | null>>(
					path(projectId, taskId),
					{ signal },
				)
			).data.data,
		...fresh,
	});
}
export function completedDeliveryRunsQueryOptions(
	projectId: string,
	taskId: string,
) {
	return infiniteQueryOptions({
		queryKey: [
			"projects",
			projectId,
			"tasks",
			taskId,
			"completed-delivery-runs",
		],
		initialPageParam: undefined as string | undefined,
		queryFn: async ({ pageParam, signal }) =>
			(
				await apiClient.instance.get<SuccessEnvelope<CompletedDeliveryRuns>>(
					`${path(projectId, taskId)}/completed-runs`,
					{ params: { cursor: pageParam }, signal },
				)
			).data.data,
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		...fresh,
	});
}
export type DeliveryCommand =
	| {
			operation: "submit";
			input: {
				requestId: string;
				expectedVersion: number;
				leaseId: string;
				pullNumber: number;
				headSha: string;
			};
	  }
	| {
			operation: "refresh";
			input: { requestId: string; expectedVersion: number };
	  }
	| {
			operation: "decision";
			input: {
				requestId: string;
				expectedVersion: number;
				decision: "accept" | "request_changes";
				note: string;
			};
	  };
export async function executeDeliveryCommand(
	projectId: string,
	taskId: string,
	command: DeliveryCommand,
): Promise<TaskDelivery> {
	return (
		await apiClient.instance.post<SuccessEnvelope<TaskDelivery>>(
			`${path(projectId, taskId)}${command.operation === "submit" ? "" : `/${command.operation}`}`,
			command.input,
		)
	).data.data;
}
