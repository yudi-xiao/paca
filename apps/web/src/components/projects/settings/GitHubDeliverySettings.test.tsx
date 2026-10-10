import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type DeliveryRepository,
	deliveryRepositoryQueryOptions,
	type RepositoryDiscovery,
} from "@/lib/github-delivery-api";
import { GitHubDeliverySettings } from "./GitHubDeliverySettings";

const mocks = vi.hoisted(() => ({
	get: vi.fn(),
	post: vi.fn(),
	put: vi.fn(),
	projectWrite: true,
	systemWrite: true,
}));
vi.mock("@/lib/api-client", () => ({
	apiClient: { instance: { get: mocks.get, post: mocks.post, put: mocks.put } },
}));
vi.mock("@/hooks/use-project-permissions", () => ({
	useProjectPermissions: () => ({
		hasProjectPermission: () => mocks.projectWrite,
	}),
}));
vi.mock("@/hooks/use-permissions", () => ({
	usePermissions: () => ({ hasPermission: () => mocks.systemWrite }),
}));
const projectId = "11111111-1111-4111-8111-111111111111";
const path = `/projects/${projectId}/github-repository`;
let binding: DeliveryRepository | null;
let found: RepositoryDiscovery;
function policy(): DeliveryRepository {
	return {
		projectId,
		repositoryId: 100,
		installationId: 200,
		status: "active",
		version: 1,
		updatedAt: new Date().toISOString(),
		policy: {
			owner: "paca-test",
			repository: "delivery",
			requiredChecks: [{ name: "Tests", appId: 123 }],
			maxCheckAgeSeconds: 86400,
			requiredApprovals: 0,
			reviewerIds: [2],
		},
	};
}
function mount() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	const view = render(
		<QueryClientProvider client={client}>
			<GitHubDeliverySettings projectId={projectId} />
		</QueryClientProvider>,
	);
	return { client, ...view };
}
async function discover() {
	await screen.findByRole("button", { name: "Discover repository checks" });
	await waitFor(() =>
		expect(
			screen.getByRole("textbox", { name: "Repository (owner/name)" }),
		).toBeEnabled(),
	);
	if (!binding) {
		await userEvent.type(
			screen.getByRole("textbox", { name: "Repository (owner/name)" }),
			"paca-test/delivery",
		);
		await userEvent.type(
			screen.getByRole("textbox", { name: /Trusted reviewer usernames/ }),
			"alice",
		);
	}
	await userEvent.type(
		screen.getByRole("spinbutton", { name: "Example PR number" }),
		"42",
	);
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: "Discover repository checks" }),
		).toBeEnabled(),
	);
	await userEvent.click(
		screen.getByRole("button", { name: "Discover repository checks" }),
	);
	await screen.findByRole("checkbox", { name: /Publisher #123/ });
}
beforeEach(() => {
	mocks.get.mockReset();
	mocks.post.mockReset();
	mocks.put.mockReset();
	mocks.systemWrite = true;
	mocks.projectWrite = true;
	binding = null;
	found = {
		owner: "paca-test",
		repository: "delivery",
		repositoryId: 100,
		installationId: 200,
		pullNumber: 42,
		headSha: "a".repeat(40),
		observedAt: new Date().toISOString(),
		checks: [
			{
				name: "Tests",
				appId: 123,
				appName: "Trusted CI",
				appSlug: "trusted-ci",
			},
			{ name: "Tests", appId: 124, appName: "Trusted CI", appSlug: "other-ci" },
		],
		reviewers: [{ id: 2, login: "alice" }],
	};
	mocks.get.mockImplementation(async () => ({
		data: { data: binding, success: true },
	}));
	mocks.post.mockImplementation(async () => ({
		data: { data: found, success: true },
	}));
	mocks.put.mockImplementation(async (_path, input) => {
		binding = {
			...policy(),
			policy: input.policy,
			version: input.expectedVersion + 1,
		};
		return { data: { data: binding, success: true } };
	});
});
describe("GitHub project delivery policy", () => {
	it("lets an administrator discover and explicitly select a pinned publisher before saving", async () => {
		mount();
		await discover();
		expect(mocks.post).toHaveBeenCalledWith(`${path}/discover`, {
			owner: "paca-test",
			repository: "delivery",
			pullNumber: 42,
			reviewerLogins: ["alice"],
		});
		const save = screen.getByRole("button", { name: "Save delivery policy" });
		expect(save).toBeDisabled();
		await userEvent.click(
			screen.getByRole("checkbox", { name: /Publisher #123/ }),
		);
		await userEvent.clear(
			screen.getByRole("spinbutton", {
				name: "Required GitHub approvals (0–5)",
			}),
		);
		await userEvent.type(
			screen.getByRole("spinbutton", {
				name: "Required GitHub approvals (0–5)",
			}),
			"1",
		);
		await userEvent.click(save);
		expect(mocks.put).toHaveBeenCalledWith(path, {
			requestId: expect.stringMatching(/^[a-f0-9-]{36}$/),
			expectedVersion: 0,
			repositoryId: 100,
			installationId: 200,
			policy: {
				owner: "paca-test",
				repository: "delivery",
				requiredChecks: [{ name: "Tests", appId: 123 }],
				reviewerIds: [2],
				requiredApprovals: 1,
				maxCheckAgeSeconds: 86400,
			},
		});
		expect(
			await screen.findByText(/Delivery policy saved/),
		).toBeInTheDocument();
	});
	it.each([
		"project",
		"system",
	])("keeps configuration read-only without %s authority", async (scope) => {
		binding = policy();
		if (scope === "project") mocks.projectWrite = false;
		else mocks.systemWrite = false;
		mount();
		expect(await screen.findByText("paca-test/delivery")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Discover repository checks" }),
		).toBeNull();
		expect(
			screen.getByText(/Changing this policy requires/),
		).toBeInTheDocument();
		expect(mocks.post).not.toHaveBeenCalled();
	});
	it("preserves existing reviewer identities and discards discovered choices after editing the target", async () => {
		binding = policy();
		mount();
		await discover();
		expect(mocks.post).toHaveBeenLastCalledWith(
			`${path}/discover`,
			expect.objectContaining({ reviewerIds: [2] }),
		);
		expect(
			screen.getByRole("textbox", { name: /Trusted reviewer usernames/ }),
		).toHaveValue("alice");
		expect(
			screen.getByRole("checkbox", { name: /Publisher #123/ }),
		).toBeChecked();
		await userEvent.type(
			screen.getByRole("textbox", { name: "Repository (owner/name)" }),
			"-new",
		);
		expect(
			screen.queryByRole("button", { name: "Save delivery policy" }),
		).toBeNull();
		expect(mocks.put).not.toHaveBeenCalled();
	});
	it("refuses stale configuration versions instead of overwriting another administrator", async () => {
		binding = policy();
		const { client } = mount();
		await discover();
		binding = { ...binding, version: 2 };
		await act(async () => {
			client.setQueryData(
				deliveryRepositoryQueryOptions(projectId).queryKey,
				binding,
			);
		});
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Save delivery policy" }),
			).toBeDisabled(),
		);
		expect(await screen.findByText(/Delivery changed/)).toBeInTheDocument();
		expect(mocks.put).not.toHaveBeenCalled();
	});
	it("retries a server-side uncertain result with exactly the same command", async () => {
		mocks.put.mockRejectedValueOnce({
			response: { status: 503, data: { error_code: "INTERNAL_ERROR" } },
		});
		mount();
		await discover();
		await userEvent.click(
			screen.getByRole("checkbox", { name: /Publisher #123/ }),
		);
		await userEvent.click(
			screen.getByRole("button", { name: "Save delivery policy" }),
		);
		const retry = await screen.findByRole("button", { name: "Retry" });
		await waitFor(() => expect(retry).toBeEnabled());
		expect(
			screen.getByRole("button", { name: "Save delivery policy" }),
		).toBeDisabled();
		await userEvent.click(retry);
		await screen.findByText(/Delivery policy saved/);
		expect(mocks.put).toHaveBeenCalledTimes(2);
		expect(mocks.put.mock.calls[0]).toEqual(mocks.put.mock.calls[1]);
	});
	it("bounds approval and age inputs and renders untrusted check names as text", async () => {
		found.checks[0] = {
			...found.checks[0],
			name: "<script>Tests</script>",
			appId: 123,
			appName: "Trusted CI",
			appSlug: "trusted-ci",
		};
		mount();
		await discover();
		await userEvent.click(
			screen.getByRole("checkbox", { name: /Publisher #123/ }),
		);
		expect(screen.getByText("<script>Tests</script>")).toBeInTheDocument();
		expect(document.querySelector("script")).toBeNull();
		const age = screen.getByRole("spinbutton", { name: /Maximum CI age/ });
		await userEvent.clear(age);
		await userEvent.type(age, "10081");
		expect(
			screen.getByRole("button", { name: "Save delivery policy" }),
		).toBeDisabled();
		expect(screen.getByText(/Choose 1–20 checks/)).toBeInTheDocument();
		await userEvent.clear(age);
		await userEvent.type(age, "1440");
		const approvals = screen.getByRole("spinbutton", {
			name: "Required GitHub approvals (0–5)",
		});
		await userEvent.clear(approvals);
		await userEvent.type(approvals, "2");
		expect(
			screen.getByRole("button", { name: "Save delivery policy" }),
		).toBeDisabled();
		expect(mocks.put).not.toHaveBeenCalled();
	});
	it("reports failed discovery without returning raw provider errors", async () => {
		mocks.post.mockRejectedValueOnce({
			response: {
				status: 503,
				data: {
					error_code: "GITHUB_DELIVERY_UNAVAILABLE",
					error: "private provider payload",
				},
			},
		});
		mount();
		await screen.findByRole("button", { name: "Discover repository checks" });
		await waitFor(() =>
			expect(
				screen.getByRole("textbox", { name: "Repository (owner/name)" }),
			).toBeEnabled(),
		);
		await userEvent.type(
			screen.getByRole("textbox", { name: "Repository (owner/name)" }),
			"paca-test/delivery",
		);
		await userEvent.type(
			screen.getByRole("spinbutton", { name: "Example PR number" }),
			"42",
		);
		await userEvent.click(
			screen.getByRole("button", { name: "Discover repository checks" }),
		);
		expect(
			await screen.findByText(/Could not verify the installed App/),
		).toBeInTheDocument();
		expect(screen.queryByText("private provider payload")).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Save delivery policy" }),
		).toBeNull();
	});
});
