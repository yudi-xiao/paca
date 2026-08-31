import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGet, mockPost, mockPatch, mockPut, mockDelete } = vi.hoisted(
	() => ({
		mockGet: vi.fn(),
		mockPost: vi.fn(),
		mockPatch: vi.fn(),
		mockPut: vi.fn(),
		mockDelete: vi.fn(),
	}),
);

vi.mock("./api-client", () => ({
	apiClient: {
		instance: {
			get: mockGet,
			post: mockPost,
			patch: mockPatch,
			put: mockPut,
			delete: mockDelete,
		},
	},
}));

import {
	createOrganizationRole,
	deleteOrganizationRole,
	listOrganizationMembers,
	listOrganizationRoles,
	organizationMembersQueryOptions,
	organizationRolesQueryOptions,
	replaceOrganizationMemberRoles,
	updateOrganizationRole,
} from "./organization-api";

const organizationId = "paca-default";
const role = {
	id: "00000000-0000-4000-8000-000000000101",
	organization_id: organizationId,
	role_name: "OWNER",
	description: "Organization owner",
	permissions: { "organization.roles.write": true },
	is_built_in: true,
	created_at: "2026-08-28T00:00:00.000Z",
	updated_at: "2026-08-28T00:00:00.000Z",
};

const member = {
	id: "member-1",
	organization_id: organizationId,
	user_id: "user-1",
	username: "owner",
	full_name: "Owner",
	email: "owner@example.com",
	avatar_url: null,
	roles: [role],
	created_at: "2026-08-28T00:00:00.000Z",
};

describe("organization-api", () => {
	beforeEach(() => vi.clearAllMocks());

	it("unwraps organization roles and members", async () => {
		mockGet
			.mockResolvedValueOnce({ data: { success: true, data: [role] } })
			.mockResolvedValueOnce({ data: { success: true, data: [member] } });

		await expect(listOrganizationRoles()).resolves.toEqual([role]);
		await expect(listOrganizationMembers()).resolves.toEqual([member]);
		expect(mockGet).toHaveBeenNthCalledWith(
			1,
			`/organizations/${organizationId}/roles`,
		);
		expect(mockGet).toHaveBeenNthCalledWith(
			2,
			`/organizations/${organizationId}/members`,
		);
	});

	it("uses the organization role CRUD contract", async () => {
		const payload = {
			role_name: "EDITOR",
			description: "Editor",
			permissions: { "projects.write": true },
		};
		mockPost.mockResolvedValue({ data: { success: true, data: role } });
		mockPatch.mockResolvedValue({ data: { success: true, data: role } });

		await createOrganizationRole(organizationId, payload);
		await updateOrganizationRole(organizationId, role.id, payload);
		await deleteOrganizationRole(organizationId, role.id);

		expect(mockPost).toHaveBeenCalledWith(
			`/organizations/${organizationId}/roles`,
			payload,
		);
		expect(mockPatch).toHaveBeenCalledWith(
			`/organizations/${organizationId}/roles/${role.id}`,
			payload,
		);
		expect(mockDelete).toHaveBeenCalledWith(
			`/organizations/${organizationId}/roles/${role.id}`,
		);
	});

	it("replaces all member roles atomically through one request", async () => {
		mockPut.mockResolvedValue({ data: { success: true, data: member } });
		await expect(
			replaceOrganizationMemberRoles(organizationId, member.id, [role.id]),
		).resolves.toEqual(member);
		expect(mockPut).toHaveBeenCalledWith(
			`/organizations/${organizationId}/members/${member.id}/roles`,
			{ role_ids: [role.id] },
		);
	});

	it("exposes stable query keys for cache invalidation", () => {
		expect(organizationRolesQueryOptions.queryKey).toEqual([
			"organizations",
			organizationId,
			"roles",
		]);
		expect(organizationMembersQueryOptions.queryKey).toEqual([
			"organizations",
			organizationId,
			"members",
		]);
	});
});
