/** Select the API runtime independently of account onboarding. */
export function usesCloudflareRuntime(): boolean {
	return import.meta.env.VITE_PACA_RUNTIME === "cloudflare";
}
/** Public account creation is disabled for the single production deployment. */
export function allowsTestSignup(): boolean {
	return false;
}
