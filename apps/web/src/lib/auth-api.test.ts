import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	changeMyPassword,
	currentUserQueryOptions,
	getMe,
	login,
	logout,
	registerInternalPreview,
} from "./auth-api";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function requestInit(): RequestInit {
	const call = vi.mocked(fetch).mock.calls[0];
	if (!call?.[1]) throw new Error("expected fetch request options");
	return call[1];
}

describe("auth-api", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	it("signs in with the Better Auth email endpoint", async () => {
		vi.mocked(fetch).mockResolvedValue(jsonResponse({ user: { id: "u1" } }));

		await login("alice@example.com", "correct-password", true);

		expect(fetch).toHaveBeenCalledWith(
			"/api/auth/sign-in/email",
			expect.objectContaining({ method: "POST", credentials: "include" }),
		);
		expect(JSON.parse(String(requestInit().body))).toEqual({
			email: "alice@example.com",
			password: "correct-password",
			rememberMe: true,
		});
	});

	it("creates an internal preview account through Better Auth", async () => {
		vi.mocked(fetch).mockResolvedValue(jsonResponse({ user: { id: "u1" } }));

		await registerInternalPreview("alice@example.com", "correct-password");

		expect(fetch).toHaveBeenCalledWith(
			"/api/auth/sign-up/email",
			expect.objectContaining({ method: "POST", credentials: "include" }),
		);
		expect(JSON.parse(String(requestInit().body))).toEqual({
			email: "alice@example.com",
			name: "alice",
			password: "correct-password",
		});
	});

	it("signs out with a JSON Better Auth request", async () => {
		vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: true }));

		await logout();

		expect(fetch).toHaveBeenCalledWith(
			"/api/auth/sign-out",
			expect.objectContaining({ method: "POST", body: "{}" }),
		);
	});

	it("changes the current password through Better Auth and revokes other sessions", async () => {
		vi.mocked(fetch).mockResolvedValue(jsonResponse({ status: true }));

		await changeMyPassword("current-password", "new-secure-password");

		expect(fetch).toHaveBeenCalledWith(
			"/api/auth/change-password",
			expect.objectContaining({ method: "POST", credentials: "include" }),
		);
		expect(JSON.parse(String(requestInit().body))).toEqual({
			currentPassword: "current-password",
			newPassword: "new-secure-password",
			revokeOtherSessions: true,
		});
	});

	it("maps the safe current-session projection to the existing web user shape", async () => {
		vi.mocked(fetch).mockResolvedValue(
			jsonResponse({
				status: "ok",
				data: {
					user: {
						id: "u1",
						name: "Alice Example",
						email: "alice@example.com",
						emailVerified: false,
						image: null,
						createdAt: "2026-08-27T00:00:00.000Z",
					},
					expiresAt: "2026-09-03T00:00:00.000Z",
				},
			}),
		);

		await expect(getMe()).resolves.toMatchObject({
			id: "u1",
			username: "alice@example.com",
			full_name: "Alice Example",
			email: "alice@example.com",
			role: "member",
			must_change_password: false,
		});
		expect(fetch).toHaveBeenCalledWith(
			"/api/me",
			expect.objectContaining({ credentials: "include" }),
		);
	});

	it("resolves null on a definitive 401", async () => {
		vi.mocked(fetch).mockResolvedValue(
			jsonResponse({ code: "UNAUTHENTICATED" }, 401),
		);

		await expect(getMe()).resolves.toBeNull();
	});

	it("rejects malformed successful session responses", async () => {
		vi.mocked(fetch).mockResolvedValue(
			jsonResponse({ status: "ok", data: {} }),
		);

		await expect(getMe()).rejects.toMatchObject({
			status: 502,
			code: "AUTH_RESPONSE_INVALID",
		});
	});

	it("exposes query options for current user", () => {
		expect(currentUserQueryOptions.queryKey).toEqual(["auth", "me"]);
		expect(currentUserQueryOptions.retry).toBe(false);
		expect(currentUserQueryOptions.staleTime).toBe(5 * 60 * 1000);
		expect(typeof currentUserQueryOptions.queryFn).toBe("function");
	});
});
