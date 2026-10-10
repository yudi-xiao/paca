import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/_authenticated/projects/$projectId/settings/index";

const mocks = vi.hoisted(() => ({
	section: "github",
	navigate: vi.fn(),
	get: vi.fn(),
	projectPermissions: new Set<string>(),
}));
vi.mock("@tanstack/react-router", () => ({
	createFileRoute: () => (options: object) => ({
		options,
		useParams: () => ({ projectId: "project" }),
		useSearch: () => ({ section: mocks.section }),
		useNavigate: () => mocks.navigate,
	}),
}));
vi.mock("@/lib/api-client", () => ({
	apiClient: { instance: { get: mocks.get } },
}));
vi.mock("@/hooks/use-permissions", () => ({
	usePermissions: () => ({ hasPermission: () => true }),
}));
vi.mock("@/hooks/use-project-permissions", () => ({
	useProjectPermissions: () => ({
		hasProjectPermission: (permission: string) =>
			mocks.projectPermissions.has(permission),
	}),
}));
vi.mock("@/lib/plugins/registry", () => ({
	usePluginRegistry: () => ({ getRegistrations: () => [] }),
}));
vi.mock("@/lib/plugins/loader", () => ({ RemoteComponent: () => null }));
vi.mock("./GitHubDeliverySettings", () => ({
	GitHubDeliverySettings: () => <div>Repository configuration form</div>,
}));
vi.mock("./GeneralSettings", () => ({
	GeneralSettings: ({ canEdit }: { canEdit: boolean }) => (
		<div>{canEdit ? "Editable project" : "Read-only project"}</div>
	),
}));
vi.mock("./DangerZone", () => ({
	DangerZone: () => <div>Delete project form</div>,
}));
vi.mock("./RolesSettings", () => ({ RolesSettings: () => null }));
vi.mock("./CustomFieldsSettings", () => ({ CustomFieldsSettings: () => null }));
vi.mock("./TaskStatusesSettings", () => ({ TaskStatusesSettings: () => null }));
vi.mock("./TaskTypesSettings", () => ({ TaskTypesSettings: () => null }));

// Exercise the settings loader and page together, with unrelated API access
// denied. A repository administrator need not have member/role read access.
async function mount() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const loader = Route.options.loader;
	if (typeof loader !== "function") throw Error("Missing settings loader");
	await loader({
		context: { queryClient: client },
		params: { projectId: "project" },
	} as Parameters<typeof loader>[0]);
	const Component = Route.options.component;
	if (!Component) throw Error("Missing settings component");
	return render(
		<QueryClientProvider client={client}>
			<Component />
		</QueryClientProvider>,
	);
}
beforeEach(() => {
	vi.stubEnv("VITE_PACA_RUNTIME", "cloudflare");
	vi.stubEnv("VITE_INTERNAL_PREVIEW", "false");
	mocks.section = "github";
	mocks.navigate.mockReset();
	mocks.get.mockReset();
	mocks.projectPermissions.clear();
	mocks.get.mockImplementation(async (path: string) => {
		if (path !== "/projects/project")
			throw Error("Unrelated permission denied");
		return { data: { success: true, data: { id: "project", name: "Paca" } } };
	});
});
describe("project settings navigation", () => {
	it("opens production GitHub settings with test signup disabled and unrelated permissions denied", async () => {
		await mount();
		expect(
			screen.getByText("Repository configuration form"),
		).toBeInTheDocument();
		await waitFor(() => expect(mocks.get).toHaveBeenCalled());
		expect(
			mocks.get.mock.calls.every(([path]) => path === "/projects/project"),
		).toBe(true);
	});
	it("falls back safely for an unavailable section and uses current project permissions", async () => {
		mocks.section = "danger";
		await mount();
		expect(screen.getByText("Read-only project")).toBeInTheDocument();
		expect(screen.queryByText("Delete project form")).toBeNull();
		await userEvent.click(
			screen.getAllByRole("button", { name: "GitHub delivery settings" })[0],
		);
		expect(mocks.navigate).toHaveBeenCalledWith({
			search: { section: "github" },
			replace: true,
		});
	});
});
