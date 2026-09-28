import { describe, expect, it } from "vitest";

import {
	INTERNAL_PREVIEW_ACTION_TYPES,
	INTERNAL_PREVIEW_TRIGGER_TYPES,
} from "./automation-api";
import {
	internalPreviewNavigationTarget,
	isInternalPreviewRouteAvailable,
} from "./internal-preview";

describe("internal preview route availability", () => {
	it("offers only Worker-executable Automation nodes", () => {
		expect(INTERNAL_PREVIEW_TRIGGER_TYPES).toEqual([
			"task_created",
			"status_changed",
		]);
		expect(INTERNAL_PREVIEW_ACTION_TYPES).toEqual(["update_task", "wait"]);
	});

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
		"/projects/6bdb7f3a-e59d-4826-8383-0104192157a8/agents",
		"/projects/6bdb7f3a-e59d-4826-8383-0104192157a8/tasks",
		"/projects/6bdb7f3a-e59d-4826-8383-0104192157a8/tasks/c9d8cdf1-b208-4c87-b71f-cf4cdf2d373a",
		"/projects/6bdb7f3a-e59d-4826-8383-0104192157a8/environments",
		"/projects/6bdb7f3a-e59d-4826-8383-0104192157a8/environments/c9d8cdf1-b208-4c87-b71f-cf4cdf2d373a/terminal",
		"/projects/6bdb7f3a-e59d-4826-8383-0104192157a8/automation",
		"/projects/6bdb7f3a-e59d-4826-8383-0104192157a8/automation/c9d8cdf1-b208-4c87-b71f-cf4cdf2d373a",
		"/projects/6bdb7f3a-e59d-4826-8383-0104192157a8/docs/c9d8cdf1-b208-4c87-b71f-cf4cdf2d373a",
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
		"/projects/project-123/docs/doc-123/activity",
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
		).toBe("/projects/project-123/automation");
		expect(
			internalPreviewNavigationTarget(
				"/projects/project-123/docs",
				"/projects/project-123",
			),
		).toBe("/projects/project-123");
	});
});
