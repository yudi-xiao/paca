import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { apiClient } from "./api-client";
import type { SuccessEnvelope } from "./api-error";

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
