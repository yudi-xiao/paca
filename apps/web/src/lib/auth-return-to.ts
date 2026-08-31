/**
 * Accept only same-origin relative application URLs for post-login return.
 * This preserves device-authorization search parameters without introducing
 * an open redirect through the public login route.
 */
export function safeAuthReturnTo(value: unknown): string | null {
	if (
		typeof value !== "string" ||
		!value.startsWith("/") ||
		value.startsWith("//") ||
		value.includes("\\")
	) {
		return null;
	}

	const parsed = new URL(value, "https://paca.invalid");
	if (parsed.origin !== "https://paca.invalid") return null;
	return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
