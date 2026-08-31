import { describe, expect, it } from "vitest";

import {
	internalPreviewNavigationTarget,
	isInternalPreviewRouteAvailable,
} from "./internal-preview";

describe("internal preview route availability", () => {
	it.each([
		"/home",
		"/home/",
		"/profile",
		"/profile/",
		"/admin/global-roles",
		"/admin/global-roles/",
		"/admin/organization-access",
		"/admin/organization-access/",
		"/admin/agents",
		"/device/capabilities",
		"/device/capabilities/",
		"/projects/6bdb7f3a-e59d-4826-8383-0104192157a8",
		"/projects/6bdb7f3a-e59d-4826-8383-0104192157a8/",
		"/projects/6bdb7f3a-e59d-4826-8383-0104192157a8/team",
		"/projects/6bdb7f3a-e59d-4826-8383-0104192157a8/tasks",
		"/projects/6bdb7f3a-e59d-4826-8383-0104192157a8/tasks/c9d8cdf1-b208-4c87-b71f-cf4cdf2d373a",
		"/projects/6bdb7f3a-e59d-4826-8383-0104192157a8/interactions/backlog",
		"/projects/6bdb7f3a-e59d-4826-8383-0104192157a8/interactions/timeline",
		"/projects/6bdb7f3a-e59d-4826-8383-0104192157a8/interactions/sprints/c9d8cdf1-b208-4c87-b71f-cf4cdf2d373a",
		"/projects/6bdb7f3a-e59d-4826-8383-0104192157a8/settings/",
	])("allows the migrated route %s", (pathname) => {
		expect(isInternalPreviewRouteAvailable(pathname)).toBe(true);
	});

	it.each([
		"/admin/users",
		"/conversations",
		"/profile/api-keys",
		"/projects/project-123/docs",
		"/projects/project-123/tasks/task-123/activity",
	])("blocks the legacy-backed route %s", (pathname) => {
		expect(isInternalPreviewRouteAvailable(pathname)).toBe(false);
	});

	it("keeps migrated navigation targets and redirects legacy targets", () => {
		expect(
			internalPreviewNavigationTarget("/projects/project-123/tasks/task-123"),
		).toBe("/projects/project-123/tasks/task-123");
		expect(
			internalPreviewNavigationTarget("/projects/project-123/automation"),
		).toBe("/home");
		expect(
			internalPreviewNavigationTarget(
				"/projects/project-123/docs",
				"/projects/project-123",
			),
		).toBe("/projects/project-123");
	});
});
