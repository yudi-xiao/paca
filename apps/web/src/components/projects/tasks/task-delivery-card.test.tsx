import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	DeliveryRepository,
	TaskDelivery,
} from "@/lib/github-delivery-api";
import { TaskDeliveryCard } from "./task-delivery-card";

const mocks = vi.hoisted(() => ({
	get: vi.fn(),
	post: vi.fn(),
	permissions: new Set(["tasks.read", "tasks.write"]),
}));
vi.mock("@/hooks/use-project-permissions", () => ({
	useProjectPermissions: () => ({
		hasProjectPermission: (permission: string) =>
			mocks.permissions.has(permission),
	}),
}));
vi.mock("@/lib/api-client", () => ({
	apiClient: { instance: { get: mocks.get, post: mocks.post } },
}));
const projectId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const leaseId = "33333333-3333-4333-8333-333333333333";
const headSha = "a".repeat(40);
const base = `/projects/${projectId}/tasks/${taskId}/delivery`;
let binding: DeliveryRepository;
let delivery: TaskDelivery | null;
function ready(): TaskDelivery {
	return {
		id: crypto.randomUUID(),
		projectId,
		taskId,
		leaseId,
		repositoryId: 100,
		policyVersion: 1,
		version: 3,
		reference: { pullNumber: 1, headSha },
		state: "awaiting_acceptance",
		requiresRefresh: false,
		acceptedBy: null,
		acceptedAt: null,
		requestedChangesBy: null,
		requestedChangesAt: null,
		reviewNote: "",
		updatedAt: new Date().toISOString(),
		lastAcceptance: null,
		evidence: {
			repository: "paca-test/delivery",
			pullNumber: 1,
			headSha,
			pullUrl: "https://github.com/paca-test/delivery/pull/1",
			observedAt: new Date().toISOString(),
			state: "awaiting_acceptance",
			reasons: [],
			approvalCount: 0,
			checks: [{ name: "Tests", appId: 123, runId: 100, state: "passed" }],
		},
	};
}
function mount() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<TaskDeliveryCard projectId={projectId} taskId={taskId} />
		</QueryClientProvider>,
	);
}
beforeEach(() => {
	mocks.get.mockReset();
	mocks.post.mockReset();
	mocks.permissions = new Set(["tasks.read", "tasks.write"]);
	delivery = null;
	binding = {
		projectId,
		repositoryId: 100,
		installationId: 200,
		version: 1,
		status: "active",
		updatedAt: new Date().toISOString(),
		policy: {
			owner: "paca-test",
			repository: "delivery",
			requiredChecks: [{ name: "Tests", appId: 123 }],
			maxCheckAgeSeconds: 86400,
			requiredApprovals: 0,
			reviewerIds: [],
		},
	};
	mocks.get.mockImplementation(async (path: string) => ({
		data: {
			success: true,
			data: path.endsWith("github-repository")
				? binding
				: path.endsWith("completed-runs")
					? {
							items: [
								{
									leaseId,
									harnessKind: "codex",
									finishedAt: new Date().toISOString(),
								},
							],
							nextCursor: null,
						}
					: delivery,
		},
	}));
	mocks.post.mockImplementation(async () => {
		delivery = ready();
		return { data: { success: true, data: delivery } };
	});
});
describe("task GitHub delivery", () => {
	it("selects a completed run and submits only a fixed reference with a new request ID", async () => {
		mount();
		const submit = await screen.findByRole("button", {
			name: "Submit delivery",
		});
		expect(submit).toBeDisabled();
		await screen.findByRole("option", { name: /codex/ });
		await userEvent.selectOptions(screen.getByRole("combobox"), leaseId);
		await userEvent.type(
			screen.getByRole("spinbutton", { name: "Pull request number" }),
			"1",
		);
		await userEvent.type(
			screen.getByRole("textbox", { name: "Commit SHA (40 characters)" }),
			headSha,
		);
		await waitFor(() => expect(submit).toBeEnabled());
		await userEvent.click(submit);
		await screen.findByText("Awaiting acceptance");
		expect(mocks.post).toHaveBeenCalledWith(base, {
			requestId: expect.stringMatching(/^[a-f0-9-]{36}$/),
			expectedVersion: 0,
			leaseId,
			pullNumber: 1,
			headSha,
		});
		expect(mocks.post).toHaveBeenCalledTimes(1);
	});
	it("blocks draft acceptance and requires a change note while rendering plain text", async () => {
		delivery = ready();
		delivery.state = "waiting";
		delivery.evidence.reasons = ["PR_IS_DRAFT"];
		delivery.reviewNote = "<script>unsafe</script>";
		mount();
		const accept = await screen.findByRole("button", {
			name: "Accept this commit",
		});
		expect(accept).toBeDisabled();
		expect(screen.getByText(/This PR is a draft/)).toBeInTheDocument();
		expect(screen.getByText("<script>unsafe</script>")).toBeInTheDocument();
		expect(document.querySelector("script")).toBeNull();
		const reject = screen.getByRole("button", { name: "Request changes" });
		expect(reject).toBeDisabled();
		await userEvent.type(
			screen.getByRole("textbox", { name: "Acceptance or change notes" }),
			"Please fix the mobile layout",
		);
		await waitFor(() => expect(reject).toBeEnabled());
		await userEvent.click(reject);
		expect(mocks.post).toHaveBeenCalledWith(
			`${base}/decision`,
			expect.objectContaining({
				expectedVersion: 3,
				decision: "request_changes",
				note: "Please fix the mobile layout",
			}),
		);
	});
	it("masks expired acceptance and does not enable accepting stale evidence", async () => {
		delivery = ready();
		delivery.state = "accepted";
		delivery.evidence.observedAt = new Date(Date.now() - 61000).toISOString();
		delivery.lastAcceptance = { actorId: "user", at: new Date().toISOString() };
		mount();
		expect(
			await screen.findByText("Evidence needs refresh"),
		).toBeInTheDocument();
		expect(screen.queryByText("Commit accepted")).toBeNull();
		expect(
			screen.getByRole("button", { name: "Accept this commit" }),
		).toBeDisabled();
		expect(screen.getByText(/Previously accepted at/)).toBeInTheDocument();
	});
	it("keeps read-only members from fetching run choices or submitting decisions", async () => {
		mocks.permissions = new Set(["tasks.read"]);
		delivery = ready();
		mount();
		await screen.findByText("Awaiting acceptance");
		expect(
			screen.queryByRole("button", { name: "Accept this commit" }),
		).toBeNull();
		expect(screen.queryByRole("combobox")).toBeNull();
		expect(
			mocks.get.mock.calls.some(([path]) =>
				String(path).endsWith("completed-runs"),
			),
		).toBe(false);
		expect(mocks.post).not.toHaveBeenCalled();
	});
	it("retries an uncertain decision with the identical request ID and version", async () => {
		delivery = ready();
		mocks.post.mockRejectedValueOnce(new Error("connection lost"));
		mount();
		const accept = await screen.findByRole("button", {
			name: "Accept this commit",
		});
		await waitFor(() => expect(accept).toBeEnabled());
		await userEvent.click(accept);
		const retry = await screen.findByRole("button", { name: "Retry" });
		await waitFor(() => expect(retry).toBeEnabled());
		expect(accept).toBeDisabled();
		await userEvent.click(retry);
		await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
		expect(mocks.post.mock.calls[0]).toEqual(mocks.post.mock.calls[1]);
	});
	it("hides the card without task read permission", () => {
		mocks.permissions.clear();
		mount();
		expect(screen.queryByText("GitHub delivery")).toBeNull();
		expect(mocks.get).not.toHaveBeenCalled();
	});
});
