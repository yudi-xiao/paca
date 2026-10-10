import { infiniteQueryOptions } from "@tanstack/react-query";
import { apiClient } from "./api-client";
import type { SuccessEnvelope } from "./api-error";

export type ProjectSearchKind = "tasks" | "docs";
export type ProjectSearchHit = {
	id: string;
	title: string;
	task_number: number | null;
	matched_in: "title" | "content";
	snippet: string;
	created_at: string;
	updated_at: string;
};
export type ProjectSearchPage = {
	items: ProjectSearchHit[];
	next_cursor: string | null;
	matching: "literal";
};
export function projectSearchQueryOptions(
	projectId: string,
	kind: ProjectSearchKind,
	query: string,
) {
	return infiniteQueryOptions({
		queryKey: ["projects", projectId, "body-search", kind, query.trim()],
		initialPageParam: undefined as string | undefined,
		queryFn: async ({ pageParam, signal }) => {
			const response = await apiClient.instance.get<
				SuccessEnvelope<ProjectSearchPage>
			>(`/projects/${projectId}/search/${kind}`, {
				params: { q: query.trim(), limit: 20, cursor: pageParam },
				signal,
			});
			return response.data.data;
		},
		getNextPageParam: (page) => page.next_cursor ?? undefined,
		// Search snippets are permission-sensitive and need fresh authorization.
		staleTime: 0,
		gcTime: 0,
		retry: false,
	});
}
