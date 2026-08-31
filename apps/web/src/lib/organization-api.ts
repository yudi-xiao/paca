import { queryOptions } from "@tanstack/react-query";

import { apiClient } from "./api-client";
import type { SuccessEnvelope } from "./api-error";

export const DEFAULT_ORGANIZATION_ID = "paca-default";

export interface OrganizationRole {
	id: string;
	organization_id: string;
	role_name: string;
	description: string;
	permissions: Record<string, boolean>;
	is_built_in: boolean;
	created_at: string;
	updated_at: string;
}

export interface OrganizationMember {
	id: string;
	organization_id: string;
	user_id: string;
	username: string;
	full_name: string;
	email: string;
	avatar_url: string | null;
	roles: OrganizationRole[];
	created_at: string;
}

export interface OrganizationRolePayload {
	role_name: string;
	description?: string;
	permissions: Record<string, boolean>;
}

export async function listOrganizationRoles(
	organizationId = DEFAULT_ORGANIZATION_ID,
): Promise<OrganizationRole[]> {
	const { data } = await apiClient.instance.get<
		SuccessEnvelope<OrganizationRole[]>
	>(`/organizations/${organizationId}/roles`);
	return data.data;
}

export async function createOrganizationRole(
	organizationId: string,
	payload: OrganizationRolePayload,
): Promise<OrganizationRole> {
	const { data } = await apiClient.instance.post<
		SuccessEnvelope<OrganizationRole>
	>(`/organizations/${organizationId}/roles`, payload);
	return data.data;
}

export async function updateOrganizationRole(
	organizationId: string,
	roleId: string,
	payload: OrganizationRolePayload,
): Promise<OrganizationRole> {
	const { data } = await apiClient.instance.patch<
		SuccessEnvelope<OrganizationRole>
	>(`/organizations/${organizationId}/roles/${roleId}`, payload);
	return data.data;
}

export async function deleteOrganizationRole(
	organizationId: string,
	roleId: string,
): Promise<void> {
	await apiClient.instance.delete(
		`/organizations/${organizationId}/roles/${roleId}`,
	);
}

export async function listOrganizationMembers(
	organizationId = DEFAULT_ORGANIZATION_ID,
): Promise<OrganizationMember[]> {
	const { data } = await apiClient.instance.get<
		SuccessEnvelope<OrganizationMember[]>
	>(`/organizations/${organizationId}/members`);
	return data.data;
}

export async function replaceOrganizationMemberRoles(
	organizationId: string,
	memberId: string,
	roleIds: string[],
): Promise<OrganizationMember> {
	const { data } = await apiClient.instance.put<
		SuccessEnvelope<OrganizationMember>
	>(`/organizations/${organizationId}/members/${memberId}/roles`, {
		role_ids: roleIds,
	});
	return data.data;
}

export const organizationRolesQueryOptions = queryOptions({
	queryKey: ["organizations", DEFAULT_ORGANIZATION_ID, "roles"],
	queryFn: () => listOrganizationRoles(DEFAULT_ORGANIZATION_ID),
	retry: false,
});

export const organizationMembersQueryOptions = queryOptions({
	queryKey: ["organizations", DEFAULT_ORGANIZATION_ID, "members"],
	queryFn: () => listOrganizationMembers(DEFAULT_ORGANIZATION_ID),
	retry: false,
});
