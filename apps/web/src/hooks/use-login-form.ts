import { useForm } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiErrorCode, getApiErrorCode } from "@/lib/api-error";
import { login, registerInternalPreview } from "@/lib/auth-api";

function loginErrorMessage(
	code: ApiErrorCode | null,
	t: TFunction<"auth">,
): string {
	if (code === ApiErrorCode.InvalidCredentials) {
		return t("login.errors.invalidCredentials");
	}
	if (code === ApiErrorCode.Unauthenticated) {
		return t("login.errors.sessionExpired");
	}
	return t("login.errors.genericError");
}

export function useLoginForm(returnTo?: string | null) {
	const { t } = useTranslation("auth");
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [serverError, setServerError] = useState<string | null>(null);
	const [isRegistering, setIsRegistering] = useState(false);

	const completeAuthentication = async () => {
		await queryClient.invalidateQueries({ queryKey: ["auth"] });
		await navigate({ href: returnTo ?? "/home", replace: true });
	};

	const form = useForm({
		defaultValues: {
			username: "",
			password: "",
			rememberMe: false,
		},
		onSubmit: async ({ value }) => {
			setServerError(null);
			try {
				await login(value.username, value.password, value.rememberMe);
				// Invalidate the entire "auth" query namespace so the ("auth"/"me")
				// cache is refreshed. Without this the sidebar keeps the previous
				// user's data.
				await completeAuthentication();
			} catch (err: unknown) {
				const code = getApiErrorCode(err);
				setServerError(loginErrorMessage(code, t));
			}
		},
	});

	const createInternalPreviewAccount = async (
		email: string,
		password: string,
	) => {
		setServerError(null);
		setIsRegistering(true);
		try {
			await registerInternalPreview(email, password);
			await completeAuthentication();
		} catch (err: unknown) {
			const code = getApiErrorCode(err);
			setServerError(loginErrorMessage(code, t));
		} finally {
			setIsRegistering(false);
		}
	};

	return { form, serverError, isRegistering, createInternalPreviewAccount };
}
