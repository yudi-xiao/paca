import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectSearch } from "./project-search";

const mocks = vi.hoisted(() => ({
	get: vi.fn(),
	permissions: new Set(["tasks.read", "docs.read"]),
}));
vi.mock("@/hooks/use-project-permissions", () => ({
	useProjectPermissions: () => ({
		hasProjectPermission: (permission: string) =>
			mocks.permissions.has(permission),
	}),
}));
vi.mock("@/lib/api-client", () => ({
	apiClient: { instance: { get: mocks.get } },
}));
vi.mock("@/components/ui/sidebar", () => ({
	SidebarMenuItem: ({ children }: { children: ReactNode }) => (
		<div>{children}</div>
	),
	SidebarMenuButton: ({
		children,
		onClick,
	}: {
		children: ReactNode;
		onClick: () => void;
	}) => (
		<button type="button" onClick={onClick}>
			{children}
		</button>
	),
}));
vi.mock("@tanstack/react-router", () => ({
	Link: ({
		children,
		params,
		onClick,
	}: {
		children: ReactNode;
		params: { projectId: string; taskId: string; docId: string };
		onClick: () => void;
	}) => (
		<a
			href={`/projects/${params.projectId}/items/${params.taskId ?? params.docId}`}
			onClick={onClick}
		>
			{children}
		</a>
	),
}));
function wrapper({ children }: { children: ReactNode }) {
	return (
		<QueryClientProvider
			client={
				new QueryClient({ defaultOptions: { queries: { retry: false } } })
			}
		>
			{children}
		</QueryClientProvider>
	);
}
const hit = {
	id: "task-1",
	title: "Release task",
	task_number: 42,
	matched_in: "content",
	snippet: "A visible <script>needle</script>",
	created_at: "2026-10-10",
	updated_at: "2026-10-10",
};
async function open() {
	render(<ProjectSearch projectId="project-1" />, { wrapper });
	await userEvent.click(
		screen.getByRole("button", { name: "Search this project" }),
	);
}
beforeEach(() => {
	mocks.get.mockReset();
	mocks.permissions = new Set(["tasks.read", "docs.read"]);
});
describe("project body search", () => {
	it("searches only after submit, renders plain snippets and loads the next cursor", async () => {
		mocks.get
			.mockResolvedValueOnce({
				data: {
					data: { items: [hit], next_cursor: "next", matching: "literal" },
				},
			})
			.mockResolvedValueOnce({
				data: {
					data: {
						items: [{ ...hit, id: "task-2", title: "Second result" }],
						next_cursor: null,
						matching: "literal",
					},
				},
			});
		await open();
		expect(mocks.get).not.toHaveBeenCalled();
		await userEvent.type(
			screen.getByRole("textbox", { name: "Search text" }),
			"needle",
		);
		expect(mocks.get).not.toHaveBeenCalled();
		await userEvent.click(
			screen.getByRole("button", { name: /^Search$/ }),
		);
		expect(await screen.findByText("#42 Release task")).toBeInTheDocument();
		expect(screen.getByText(hit.snippet)).toBeInTheDocument();
		expect(document.querySelector("script")).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "Load more" }));
		expect(await screen.findByText("#42 Second result")).toBeInTheDocument();
		expect(mocks.get).toHaveBeenLastCalledWith(
			"/projects/project-1/search/tasks",
			expect.objectContaining({
				params: { q: "needle", limit: 20, cursor: "next" },
				signal: expect.any(AbortSignal),
			}),
		);
	});
	it("supports document-only permissions and an empty result", async () => {
		mocks.permissions = new Set(["docs.read"]);
		mocks.get.mockResolvedValue({
			data: { data: { items: [], next_cursor: null, matching: "literal" } },
		});
		await open();
		expect(
			screen.queryByRole("option", { name: "Tasks" }),
		).not.toBeInTheDocument();
		await userEvent.type(screen.getByRole("textbox"), "needle{Enter}");
		expect(
			await screen.findByText(
				"No matches. Try another keyword or search type.",
			),
		).toBeInTheDocument();
		expect(mocks.get).toHaveBeenCalledWith(
			"/projects/project-1/search/docs",
			expect.anything(),
		);
	});
	it("shows a retryable error and closes the dialog on a result", async () => {
		mocks.get
			.mockRejectedValueOnce(new Error("transport private detail"))
			.mockResolvedValueOnce({
				data: {
					data: { items: [hit], next_cursor: null, matching: "literal" },
				},
			});
		await open();
		await userEvent.type(screen.getByRole("textbox"), "needle{Enter}");
		expect(await screen.findByRole("alert")).not.toHaveTextContent(
			"private detail",
		);
		await userEvent.click(screen.getByRole("button", { name: "Retry" }));
		await userEvent.click(await screen.findByText("#42 Release task"));
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
	});
	it("hides the entry when no body read permission exists", () => {
		mocks.permissions.clear();
		render(<ProjectSearch projectId="project-1" />, { wrapper });
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
		expect(mocks.get).not.toHaveBeenCalled();
	});
});
