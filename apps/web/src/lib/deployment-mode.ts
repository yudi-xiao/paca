/** Runtime selection is independent from whether test signup is exposed. */
export function usesCloudflareRuntime(): boolean {
	return import.meta.env.VITE_PACA_RUNTIME === "cloudflare";
}

export function allowsInternalTestSignup(): boolean {
	return (
		usesCloudflareRuntime() && import.meta.env.VITE_INTERNAL_PREVIEW === "true"
	);
}
