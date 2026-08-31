import { queryOptions } from "@tanstack/react-query";

import { apiClient } from "./api-client";

type JsonRecord = Record<string, unknown>;

type BetterAuthUser = {
	id: string;
	name: string;
	email: string;
	emailVerified: boolean;
	image: string | null;
	createdAt: string;
};

type CurrentUserResponse = {
	status: "ok";
	data: {
		user: BetterAuthUser;
		expiresAt: string;
	};
};

export class AuthApiError extends Error {
	readonly status: number;
	readonly code: string | null;

	constructor(status: number, code: string | null) {
		super(code ?? `AUTH_HTTP_${status}`);
		this.name = "AuthApiError";
		this.status = status;
		this.code = code;
	}
}

function asRecord(value: unknown): JsonRecord | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonRecord)
		: null;
}

async function readJson(response: Response): Promise<unknown> {
	const contentType = response.headers.get("content-type") ?? "";
	return contentType.includes("application/json") ? response.json() : null;
}

function isCurrentUserResponse(value: unknown): value is CurrentUserResponse {
	const root = asRecord(value);
	const data = asRecord(root?.data);
	const user = asRecord(data?.user);
	return (
		root?.status === "ok" &&
		typeof data?.expiresAt === "string" &&
		typeof user?.id === "string" &&
		typeof user?.name === "string" &&
		typeof user?.email === "string" &&
		typeof user?.emailVerified === "boolean" &&
		(user?.image === null || typeof user?.image === "string") &&
		typeof user?.createdAt === "string"
	);
}

async function authRequest(
	path: string,
	init: RequestInit = {},
): Promise<unknown> {
	const headers = new Headers(init.headers);
	headers.set("content-type", "application/json");
	const response = await fetch(path, {
		...init,
		credentials: "include",
		headers,
	});
	const body = await readJson(response);

	if (!response.ok) {
		const code = asRecord(body)?.code;
		throw new AuthApiError(
			response.status,
			typeof code === "string" ? code : null,
		);
	}

	return body;
}

/** Shape of the authenticated user returned by GET /users/me. */
export interface User {
	id: string;
	username: string;
	full_name: string;
	email?: string | null;
	role: string;
	must_change_password: boolean;
	avatar_url?: string | null;
	avatar_thumb_url?: string | null;
	created_at: string;
}

export async function changeMyPassword(
	currentPassword: string,
	newPassword: string,
): Promise<void> {
	await authRequest("/api/auth/change-password", {
		method: "POST",
		body: JSON.stringify({
			currentPassword,
			newPassword,
			revokeOtherSessions: true,
		}),
	});
}

/**
 * Sets an account's password using a single-use token — the public,
 * unauthenticated flow a password-set-link email points to (see the
 * plugin-triggered welcome/invite email). The token proves the caller's
 * right to act on the account instead of a session or current password.
 */
export async function setPasswordWithToken(
	token: string,
	newPassword: string,
): Promise<void> {
	await apiClient.instance.post("/auth/password/set", {
		token,
		new_password: newPassword,
	});
}

export async function login(
	email: string,
	password: string,
	rememberMe: boolean,
): Promise<void> {
	await authRequest("/api/auth/sign-in/email", {
		method: "POST",
		body: JSON.stringify({
			email,
			password,
			rememberMe,
		}),
	});
}

export async function registerInternalPreview(
	email: string,
	password: string,
): Promise<void> {
	const localPart = email.split("@", 1)[0]?.trim();
	await authRequest("/api/auth/sign-up/email", {
		method: "POST",
		body: JSON.stringify({
			email,
			name: localPart || "Paca Internal Tester",
			password,
		}),
	});
}

export async function logout(): Promise<void> {
	await authRequest("/api/auth/sign-out", {
		method: "POST",
		body: "{}",
	});
}

/**
 * Resolves to `null` on a definitive 401 (not authenticated) instead of
 * throwing, so every consumer shares one query cache entry — a route
 * `beforeLoad` requiring a signed-in user, and a component just wanting to
 * know who's logged in, both read the exact same cached "auth","me" result.
 * Splitting those into two cache keys used to mean loading a page fired
 * /users/me twice: once from the route's beforeLoad guard, once again from
 * whichever component read the other key. Any other error (network,
 * timeouts) re-throws so React Query keeps the last good data instead of
 * overwriting it with null.
 */
export async function getMe(): Promise<User | null> {
	try {
		const response = await authRequest("/api/me");
		if (!isCurrentUserResponse(response)) {
			throw new AuthApiError(502, "AUTH_RESPONSE_INVALID");
		}
		const { user } = response.data;
		return {
			id: user.id,
			username: user.email,
			full_name: user.name,
			email: user.email,
			role: "member",
			must_change_password: false,
			avatar_url: user.image,
			avatar_thumb_url: user.image,
			created_at: user.createdAt,
		};
	} catch (err) {
		if (err instanceof AuthApiError && err.status === 401) {
			return null;
		}
		throw err;
	}
}

export const currentUserQueryOptions = queryOptions({
	queryKey: ["auth", "me"],
	queryFn: getMe,
	retry: false,
	staleTime: 5 * 60 * 1000,
});
