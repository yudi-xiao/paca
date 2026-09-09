import { queryOptions } from "@tanstack/react-query";

import { apiClient } from "./api-client";
import type { SuccessEnvelope } from "./api-error";

export type CloudflareEnvironment = {
	id: string;
	project_id: string;
	name: string;
	status: "ready_on_demand";
	backend: "cloudflare-sandbox" | "cloudflare-computer" | "legacy-agent-runner";
	created_by: string | null;
	created_at: string;
	updated_at: string;
};

export async function listCloudflareEnvironments(
	projectId: string,
): Promise<CloudflareEnvironment[]> {
	const { data } = await apiClient.instance.get<
		SuccessEnvelope<{ environments: CloudflareEnvironment[] }>
	>(`/projects/${projectId}/environments`);
	return data.data.environments;
}

export async function createCloudflareEnvironment(
	projectId: string,
	name: string,
): Promise<CloudflareEnvironment> {
	const { data } = await apiClient.instance.post<
		SuccessEnvelope<CloudflareEnvironment>
	>(`/projects/${projectId}/environments`, { name });
	return data.data;
}

export async function renameCloudflareEnvironment(
	projectId: string,
	environmentId: string,
	name: string,
): Promise<CloudflareEnvironment> {
	const { data } = await apiClient.instance.patch<
		SuccessEnvelope<CloudflareEnvironment>
	>(`/projects/${projectId}/environments/${environmentId}`, { name });
	return data.data;
}

export async function archiveCloudflareEnvironment(
	projectId: string,
	environmentId: string,
): Promise<void> {
	await apiClient.instance.delete(
		`/projects/${projectId}/environments/${environmentId}`,
	);
}

export const cloudflareEnvironmentsQueryOptions = (projectId: string) =>
	queryOptions({
		queryKey: ["projects", projectId, "cloudflare-environments"],
		queryFn: () => listCloudflareEnvironments(projectId),
	});
