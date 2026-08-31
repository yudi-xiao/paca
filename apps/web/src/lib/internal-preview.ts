const INTERNAL_PREVIEW_ROUTES = new Set([
	"/home",
	"/profile",
	"/admin/global-roles",
	"/admin/organization-access",
	"/admin/agents",
	"/device/capabilities",
]);

function normalizePathname(pathname: string): string {
	if (pathname.length > 1 && pathname.endsWith("/")) {
		return pathname.slice(0, -1);
	}
	return pathname;
}

const INTERNAL_PREVIEW_PROJECT_ROUTE =
	/^\/projects\/[^/]+(?:\/(?:team|settings|tasks(?:\/[^/]+)?|interactions\/(?:backlog|timeline|sprints\/[^/]+)))?$/;

/**
 * The Cloudflare internal preview exposes only routes whose backing APIs have
 * already moved behind the same-origin Worker boundary. Keeping this list
 * explicit prevents legacy pages from rendering and then issuing guaranteed
 * 404 requests to Go endpoints that are not part of the preview deployment.
 */
export function isInternalPreviewRouteAvailable(pathname: string): boolean {
	const normalized = normalizePathname(pathname);
	return (
		INTERNAL_PREVIEW_ROUTES.has(normalized) ||
		INTERNAL_PREVIEW_PROJECT_ROUTE.test(normalized)
	);
}

/**
 * Resolve every client-side navigation through the same capability boundary
 * used by the authenticated route loader. This also covers keyboard shortcuts
 * and imperative navigation, which can otherwise bypass hidden sidebar items
 * and mount a legacy route whose API is not present in the Worker deployment.
 */
export function internalPreviewNavigationTarget(
	pathname: string,
	fallback = "/home",
): string {
	return isInternalPreviewRouteAvailable(pathname) ? pathname : fallback;
}
