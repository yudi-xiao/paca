import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDelete, mockGet, mockPatch, mockPost } = vi.hoisted(() => ({
	mockDelete: vi.fn(),
	mockGet: vi.fn(),
	mockPatch: vi.fn(),
	mockPost: vi.fn(),
}));

vi.mock("./api-client", () => ({
	apiClient: {
		instance: {
			delete: mockDelete,
			get: mockGet,
			patch: mockPatch,
			post: mockPost,
		},
	},
}));

import {
	archiveCloudflareEnvironment,
	cloudflareEnvironmentQueryOptions,
	cloudflareEnvironmentsQueryOptions,
	createCloudflareEnvironment,
	getCloudflareEnvironment,
	getCloudflareEnvironmentTerminalTicket,
	listCloudflareEnvironments,
	renameCloudflareEnvironment,
} from "./cloudflare-environment-api";

const environment = {
	id: "environment-1",
	project_id: "project-1",
	name: "Primary sandbox",
	status: "ready_on_demand" as const,
	backend: "cloudflare-sandbox" as const,
	created_by: "user-1",
	created_at: "2026-09-09T00:00:00.000Z",
	updated_at: "2026-09-09T00:00:00.000Z",
};

function ok<T>(data: T) {
	return { data: { success: true, data } };
}

describe("cloudflare environment api", () => {
	beforeEach(() => vi.clearAllMocks());

	it("lists environments and keeps a Worker-native cache namespace", async () => {
		mockGet.mockResolvedValue(ok({ environments: [environment] }));

		await expect(listCloudflareEnvironments("project-1")).resolves.toEqual([
			environment,
		]);
		expect(mockGet).toHaveBeenCalledWith("/projects/project-1/environments");
		expect(cloudflareEnvironmentsQueryOptions("project-1").queryKey).toEqual([
			"projects",
			"project-1",
			"cloudflare-environments",
		]);
	});

	it("sends only mutable resource metadata", async () => {
		mockPost.mockResolvedValue(ok(environment));
		mockPatch.mockResolvedValue(ok({ ...environment, name: "Renamed" }));

		await createCloudflareEnvironment("project-1", "Primary sandbox");
		expect(mockPost).toHaveBeenCalledWith("/projects/project-1/environments", {
			name: "Primary sandbox",
		});

		await renameCloudflareEnvironment("project-1", "environment-1", "Renamed");
		expect(mockPatch).toHaveBeenCalledWith(
			"/projects/project-1/environments/environment-1",
			{ name: "Renamed" },
		);
	});

	it("loads one environment and issues a browser terminal ticket", async () => {
		const ticket = {
			ticket: "short-lived-ticket",
			ws_url: "wss://paca-env.howlearnwood.com/v1/connect",
			expires_at: "2026-09-09T00:01:00.000Z",
		};
		mockGet.mockResolvedValue(ok(environment));
		mockPost.mockResolvedValue(ok(ticket));

		await expect(
			getCloudflareEnvironment("project-1", "environment-1"),
		).resolves.toEqual(environment);
		expect(mockGet).toHaveBeenCalledWith(
			"/projects/project-1/environments/environment-1",
		);
		expect(
			cloudflareEnvironmentQueryOptions("project-1", "environment-1").queryKey,
		).toEqual([
			"projects",
			"project-1",
			"cloudflare-environments",
			"environment-1",
		]);

		await expect(
			getCloudflareEnvironmentTerminalTicket("project-1", "environment-1"),
		).resolves.toEqual(ticket);
		expect(mockPost).toHaveBeenCalledWith(
			"/projects/project-1/environments/environment-1/terminal-ticket",
		);
	});

	it("archives through the scoped resource route", async () => {
		mockDelete.mockResolvedValue({});

		await archiveCloudflareEnvironment("project-1", "environment-1");
		expect(mockDelete).toHaveBeenCalledWith(
			"/projects/project-1/environments/environment-1",
		);
	});
});
