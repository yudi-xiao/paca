import { describe, expect, it, vi } from "vitest";

import {
  type DocumentRepository,
  DocumentService,
  documentErrorCodes,
  type PacaDocument,
  type PersistedDocumentCreate,
  type PersistedDocumentUpdate,
} from "../src/document/service";

const projectId = "6bdb7f3a-e59d-4826-8383-0104192157a8";
const documentId = "44444444-4444-4444-8444-444444444444";

const document: PacaDocument = {
  id: documentId,
  projectId,
  title: "Architecture",
  content: [{ type: "paragraph", content: [] }],
  contentVersion: 1,
  position: 0,
  createdBy: "user-1",
  updatedBy: "user-1",
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
};

function repository(overrides: Partial<DocumentRepository> = {}): DocumentRepository {
  return {
    list: async () => [document],
    findById: async () => document,
    create: async () => document,
    update: async () => document,
    archive: async () => undefined,
    ...overrides,
  };
}

describe("document service", () => {
  it("normalizes document creation and binds the trusted user actor", async () => {
    const create = vi.fn(async (_input: PersistedDocumentCreate) => document);
    const service = new DocumentService(repository({ create }));

    await service.create(projectId, "user-1", {
      title: "  Architecture  ",
      content: [{ type: "paragraph", content: [] }],
      position: 4,
    });

    expect(create).toHaveBeenCalledWith({
      id: expect.any(String),
      projectId,
      title: "Architecture",
      content: [{ type: "paragraph", content: [] }],
      position: 4,
      actorUserId: "user-1",
    });
  });

  it("rejects malformed, oversized, and out-of-range document fields", async () => {
    const service = new DocumentService(repository());

    expect(() => service.create(projectId, "user-1", { title: "x".repeat(501) })).toThrowError(
      expect.objectContaining({ code: documentErrorCodes.titleInvalid }),
    );
    expect(() => service.create(projectId, "user-1", { content: { text: "bad" } })).toThrowError(
      expect.objectContaining({ code: documentErrorCodes.contentInvalid }),
    );
    expect(() =>
      service.create(projectId, "user-1", { content: ["x".repeat(512_001)] }),
    ).toThrowError(expect.objectContaining({ code: documentErrorCodes.contentInvalid }));
    expect(() => service.create(projectId, "user-1", { position: 1.5 })).toThrowError(
      expect.objectContaining({ code: documentErrorCodes.positionInvalid }),
    );
  });

  it("normalizes metadata and skips empty updates", async () => {
    const update = vi.fn(
      async (
        _projectId: string,
        _documentId: string,
        _actorUserId: string,
        _input: PersistedDocumentUpdate,
      ) => document,
    );
    const findById = vi.fn(async () => document);
    const service = new DocumentService(repository({ update, findById }));

    await service.update(projectId, documentId, "user-1", { title: "  Updated  " });
    expect(update).toHaveBeenCalledWith(projectId, documentId, "user-1", { title: "Updated" });

    await service.update(projectId, documentId, "user-1", {});
    expect(findById).toHaveBeenCalledWith(projectId, documentId);
  });
});
