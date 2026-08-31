import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGet, mockPost } = vi.hoisted(() => ({
	mockGet: vi.fn(),
	mockPost: vi.fn(),
}));

vi.mock("./api-client", () => ({
	apiClient: {
		instance: {
			get: mockGet,
			post: mockPost,
		},
	},
}));

import {
	listTaskAttachments,
	restoreTaskAttachment,
	taskAttachmentsQueryOptions,
} from "./attachment-api";

const projectId = "project-1";
const taskId = "task-1";
const attachment = {
	id: "attachment-1",
	task_id: taskId,
	file_id: "file-1",
	created_at: "2026-08-28T00:00:00.000Z",
	deleted_at: "2026-08-28T01:00:00.000Z",
	purge_after: "2026-09-27T01:00:00.000Z",
	file: {
		id: "file-1",
		file_name: "report.pdf",
		content_type: "application/pdf",
		file_size: 4,
		created_at: "2026-08-28T00:00:00.000Z",
	},
};

describe("attachment-api", () => {
	beforeEach(() => vi.clearAllMocks());

	it("keeps active and recently deleted attachment queries in separate cache entries", async () => {
		mockGet.mockResolvedValue({ data: { data: { items: [attachment] } } });

		await expect(
			listTaskAttachments(projectId, taskId, { deleted: true }),
		).resolves.toEqual([attachment]);
		expect(mockGet).toHaveBeenCalledWith(
			`/projects/${projectId}/tasks/${taskId}/attachments?deleted=true`,
		);
		expect(taskAttachmentsQueryOptions(projectId, taskId).queryKey).not.toEqual(
			taskAttachmentsQueryOptions(projectId, taskId, { deleted: true })
				.queryKey,
		);
	});

	it("posts to the restore endpoint and unwraps the restored attachment", async () => {
		mockPost.mockResolvedValue({
			data: { data: { ...attachment, deleted_at: null, purge_after: null } },
		});

		await expect(
			restoreTaskAttachment(projectId, taskId, attachment.id),
		).resolves.toMatchObject({ id: attachment.id, deleted_at: null });
		expect(mockPost).toHaveBeenCalledWith(
			`/projects/${projectId}/tasks/${taskId}/attachments/${attachment.id}/restore`,
		);
	});
});
