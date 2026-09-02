import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	type AgentAuthApiError,
	approveAgentHostLabels,
	createAgentAuthHost,
	getAgentAuthConfiguration,
	grantAutonomousProjectRead,
	listAgentAuthAgents,
	listAgentAuthHosts,
	listAgentHostRuntimes,
	reauthenticateAndApproveAgent,
	resolveAgentAuthorization,
	revokeAgentAuthAgent,
	revokeAgentAuthHost,
	revokeAutonomousProjectRead,
} from "./agent-auth-api";

describe("agent-auth-api", () => {
	beforeEach(() => vi.restoreAllMocks());

	it("lists agents from the Better Auth Agent Auth endpoint", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					agents: [{ agent_id: "agent-1", name: "Reviewer" }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		await expect(listAgentAuthAgents()).resolves.toMatchObject([
			{ agent_id: "agent-1", name: "Reviewer" },
		]);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/auth/agent/list",
			expect.objectContaining({ credentials: "include" }),
		);
	});

	it("reads autonomous availability from Agent Auth discovery", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({ modes: ["delegated", "autonomous", "invalid"] }),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			),
		);

		await expect(getAgentAuthConfiguration()).resolves.toEqual({
			modes: ["delegated", "autonomous"],
		});
		expect(fetchMock).toHaveBeenCalledWith("/.well-known/agent-configuration", {
			credentials: "include",
		});
	});

	it("approves and revokes through Agent Auth rather than legacy agent APIs", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(JSON.stringify({ status: "ok" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);

		await resolveAgentAuthorization({
			agentId: "agent-1",
			userCode: "ABCD-1234",
			action: "approve",
		});
		await revokeAgentAuthAgent("agent-1");

		expect(fetchMock).toHaveBeenNthCalledWith(
			1,
			"/api/auth/agent/approve-capability",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					agent_id: "agent-1",
					user_code: "ABCD-1234",
					action: "approve",
				}),
			}),
		);
		expect(fetchMock).toHaveBeenNthCalledWith(
			2,
			"/api/auth/agent/revoke",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ agent_id: "agent-1" }),
			}),
		);
	});

	it("creates, lists, and revokes Agent Hosts through the enrollment protocol", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (input) => {
				if (input === "/api/auth/host/create") {
					return new Response(
						JSON.stringify({
							hostId: "host-1",
							status: "pending_enrollment",
							enrollmentToken: "secret-enrollment-token",
							default_capabilities: [],
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				}
				if (input === "/api/auth/host/list") {
					return new Response(
						JSON.stringify({ hosts: [{ id: "host-1", name: "Runner" }] }),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				}
				return new Response(JSON.stringify({ status: "revoked" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			});

		await expect(createAgentAuthHost("Runner")).resolves.toMatchObject({
			hostId: "host-1",
			enrollmentToken: "secret-enrollment-token",
		});
		await expect(listAgentAuthHosts()).resolves.toMatchObject([
			{ id: "host-1", name: "Runner" },
		]);
		await revokeAgentAuthHost("host-1");

		expect(fetchMock).toHaveBeenNthCalledWith(
			1,
			"/api/auth/host/create",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ name: "Runner" }),
			}),
		);
		expect(fetchMock).toHaveBeenNthCalledWith(
			3,
			"/api/auth/host/revoke",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ host_id: "host-1" }),
			}),
		);
	});

	it("lists Host presence and updates only server-approved labels", async () => {
		const runtime = {
			host_id: "host-1",
			host_name: "Runner",
			host_status: "active",
			approved_labels: ["task:execute"],
			reported_labels: ["task:execute", "harness:codex"],
			reported_harness_kinds: ["codex"],
			effective_labels: ["task:execute"],
			labels_version: 1,
			online: true,
		};
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (input) =>
				input === "/api/v1/agent/hosts/runtime"
					? Response.json({ success: true, data: [runtime] })
					: Response.json({
							success: true,
							data: { ...runtime, labels_version: 2 },
						}),
			);

		await expect(listAgentHostRuntimes()).resolves.toMatchObject([runtime]);
		await expect(
			approveAgentHostLabels({
				hostId: "host-1",
				approvedLabels: ["task:execute", "harness:codex"],
			}),
		).resolves.toMatchObject({ host_id: "host-1", labels_version: 2 });

		expect(fetchMock).toHaveBeenNthCalledWith(
			2,
			"/api/v1/agent/hosts/host-1/runtime",
			expect.objectContaining({
				method: "PUT",
				credentials: "include",
				body: JSON.stringify({
					approved_labels: ["task:execute", "harness:codex"],
				}),
			}),
		);
	});

	it("preserves Agent Auth error codes for the approval UI", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ code: "INVALID_USER_CODE" }), {
				status: 403,
				headers: { "content-type": "application/json" },
			}),
		);

		await expect(
			resolveAgentAuthorization({
				agentId: "agent-1",
				userCode: "wrong",
				action: "approve",
			}),
		).rejects.toEqual(
			expect.objectContaining<Partial<AgentAuthApiError>>({
				status: 403,
				code: "INVALID_USER_CODE",
			}),
		);
	});

	it("prefers a Paca approval error in message over the generic HTTP code", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					code: "FORBIDDEN",
					message: "AGENT_APPROVAL_PERMISSION_DENIED",
				}),
				{ status: 403, headers: { "content-type": "application/json" } },
			),
		);

		await expect(
			resolveAgentAuthorization({
				agentId: "agent-1",
				userCode: "ABCD-1234",
				action: "approve",
			}),
		).rejects.toMatchObject({ code: "AGENT_APPROVAL_PERMISSION_DENIED" });
	});

	it("creates a fresh session and retries the same approval context", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(JSON.stringify({ status: "approved" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);

		await reauthenticateAndApproveAgent({
			email: "approver@paca.test",
			password: "correct-horse-battery-staple",
			agentId: "agent-1",
			userCode: "ABCD-1234",
		});

		expect(fetchMock).toHaveBeenNthCalledWith(
			1,
			"/api/auth/sign-in/email",
			expect.objectContaining({
				method: "POST",
				credentials: "include",
				body: JSON.stringify({
					email: "approver@paca.test",
					password: "correct-horse-battery-staple",
					rememberMe: false,
				}),
			}),
		);
		expect(fetchMock).toHaveBeenNthCalledWith(
			2,
			"/api/auth/agent/approve-capability",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					agent_id: "agent-1",
					user_code: "ABCD-1234",
					action: "approve",
				}),
			}),
		);
	});

	it("grants and revokes a short-lived autonomous Project read capability", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-28T00:00:00.000Z"));
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(JSON.stringify({ status: "ok" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);

		await grantAutonomousProjectRead({
			agentId: "agent-autonomous",
			projectId: "11111111-1111-4111-8111-111111111111",
		});
		await revokeAutonomousProjectRead("agent-autonomous");

		expect(fetchMock).toHaveBeenNthCalledWith(
			1,
			"/api/auth/agent/grant-capability",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					agent_id: "agent-autonomous",
					capabilities: [
						{
							name: "project.read",
							constraints: {
								organizationId: "paca-default",
								projectId: "11111111-1111-4111-8111-111111111111",
								validUntil: "2026-08-28T00:15:00.000Z",
							},
						},
					],
					ttl: 900,
				}),
			}),
		);
		expect(fetchMock).toHaveBeenNthCalledWith(
			2,
			"/api/auth/paca-agent/revoke-capability",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					agent_id: "agent-autonomous",
					capabilities: ["project.read"],
				}),
			}),
		);
		vi.useRealTimers();
	});
});
