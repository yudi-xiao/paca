import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionConfig } from "@/lib/automation-api";
import { SprintActionConfig } from "./sprint-action-config";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api-client", () => ({
	apiClient: { instance: { get: mocks.get } },
}));
const destination = "11111111-1111-4111-8111-111111111111";
function mount(
	type = "update_sprint",
	config: ActionConfig = {},
	canEdit = true,
	saving = false,
) {
	const onSave = vi.fn();
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<SprintActionConfig
				type={type}
				config={config}
				projectId="project"
				canEdit={canEdit}
				saving={saving}
				onSave={onSave}
			/>
		</QueryClientProvider>,
	);
	return onSave;
}
beforeEach(() => {
	mocks.get.mockReset();
	mocks.get.mockResolvedValue({
		data: {
			data: {
				items: [
					{ id: destination, name: "Next", status: "planned" },
					{ id: "completed", name: "Finished", status: "completed" },
				],
			},
		},
	});
});
describe("Sprint action editing", () => {
	it("keeps omitted fields untouched, validates a blank name, and supports explicit clearing", async () => {
		const save = mount();
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
		await userEvent.click(screen.getByRole("checkbox", { name: "Set Name" }));
		expect(screen.getByRole("alert")).toHaveTextContent("1–200");
		await userEvent.type(
			screen.getByRole("textbox", { name: "Name" }),
			"Release",
		);
		await userEvent.click(screen.getByRole("checkbox", { name: "Set Goal" }));
		await userEvent.click(screen.getByRole("checkbox", { name: "Clear Goal" }));
		expect(screen.getByRole("textbox", { name: "Goal" })).toBeDisabled();
		await userEvent.click(
			screen.getByRole("checkbox", { name: "Set Start date" }),
		);
		await userEvent.click(
			screen.getByRole("checkbox", { name: "Clear Start date" }),
		);
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(save).toHaveBeenCalledWith({
			sprint_update: { name: "Release", goal: null, start_date: null },
		});
		expect(mocks.get).not.toHaveBeenCalled();
	});
	it("rejects inverted dates and lets users disable a field instead of silently clearing it", async () => {
		const save = mount("update_sprint", {
			sprint_update: { start_date: "2026-10-20", end_date: "2026-10-10" },
		});
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
		await userEvent.click(
			screen.getByRole("checkbox", { name: "Set End date" }),
		);
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(save).toHaveBeenCalledWith({
			sprint_update: { start_date: "2026-10-20" },
		});
	});
	it("explains status-only completion and prevents changes during a save", () => {
		mount(
			"update_sprint",
			{ sprint_update: { status: "completed" } },
			true,
			true,
		);
		expect(
			screen.getByText(/Changing status does not move tasks/),
		).toBeInTheDocument();
		expect(screen.getByRole("combobox", { name: "Status" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
	});
	it("shows available destinations, omits completed Sprints, and does not replace a missing selection", async () => {
		const save = mount("complete_sprint", { move_to_sprint_id: "missing" });
		await screen.findByRole("option", { name: "Next" });
		expect(
			screen.queryByRole("option", { name: "Finished" }),
		).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
		expect(screen.getByRole("combobox")).toHaveValue("missing");
		await userEvent.selectOptions(screen.getByRole("combobox"), destination);
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(save).toHaveBeenCalledWith({ move_to_sprint_id: destination });
	});
	it("offers retry on a load failure and keeps the chosen destination until it is verified", async () => {
		mocks.get.mockRejectedValueOnce(new Error("offline"));
		const save = mount("complete_sprint", { move_to_sprint_id: destination });
		await screen.findByRole("button", { name: "Retry" });
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
		expect(screen.getByRole("combobox")).toHaveValue(destination);
		await userEvent.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(),
		);
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(save).toHaveBeenCalledWith({ move_to_sprint_id: destination });
	});
	it("renders a read-only configuration without a save action", () => {
		mount("update_sprint", { sprint_update: { name: "Release" } }, false);
		expect(
			screen.queryByRole("button", { name: "Save" }),
		).not.toBeInTheDocument();
		expect(screen.getByRole("textbox", { name: "Name" })).toBeDisabled();
		expect(screen.getByRole("checkbox", { name: "Set Name" })).toBeDisabled();
	});
});
