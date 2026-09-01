export const documentErrorCodes = {
  contentInvalid: "DOC_CONTENT_INVALID",
  notFound: "DOC_NOT_FOUND",
  positionInvalid: "DOC_POSITION_INVALID",
  titleInvalid: "DOC_TITLE_INVALID",
} as const;

export type DocumentErrorCode = (typeof documentErrorCodes)[keyof typeof documentErrorCodes];

export class DocumentError extends Error {
  constructor(
    readonly code: DocumentErrorCode,
    message = code,
  ) {
    super(message);
    this.name = "DocumentError";
  }
}

export type PacaDocument = {
  id: string;
  projectId: string;
  title: string;
  content: unknown[] | null;
  contentVersion: number;
  position: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type DocumentCreateInput = {
  title?: string;
  content?: unknown;
  position?: number;
};

export type DocumentUpdateInput = {
  title?: string;
  position?: number;
};

export type PersistedDocumentCreate = {
  id: string;
  projectId: string;
  title: string;
  content: unknown[] | null;
  position: number;
  actorUserId: string;
};

export type PersistedDocumentUpdate = {
  title?: string;
  position?: number;
};

export interface DocumentRepository {
  list(projectId: string): Promise<PacaDocument[]>;
  findById(projectId: string, documentId: string): Promise<PacaDocument>;
  create(input: PersistedDocumentCreate): Promise<PacaDocument>;
  update(
    projectId: string,
    documentId: string,
    actorUserId: string,
    input: PersistedDocumentUpdate,
  ): Promise<PacaDocument>;
  archive(projectId: string, documentId: string, actorUserId: string): Promise<void>;
}

function normalizeTitle(value: string | undefined): string {
  const title = value?.trim() || "Untitled";
  if (title.length > 500) throw new DocumentError(documentErrorCodes.titleInvalid);
  return title;
}

function normalizeContent(value: unknown): unknown[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new DocumentError(documentErrorCodes.contentInvalid);
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > 512_000) {
      throw new DocumentError(documentErrorCodes.contentInvalid);
    }
    return JSON.parse(serialized) as unknown[];
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    throw new DocumentError(documentErrorCodes.contentInvalid);
  }
}

function normalizePosition(value: number | undefined): number {
  const position = value ?? 0;
  if (!Number.isInteger(position) || Math.abs(position) > 1_000_000) {
    throw new DocumentError(documentErrorCodes.positionInvalid);
  }
  return position;
}

export class DocumentService {
  constructor(private readonly repository: DocumentRepository) {}

  list(projectId: string): Promise<PacaDocument[]> {
    return this.repository.list(projectId);
  }

  get(projectId: string, documentId: string): Promise<PacaDocument> {
    return this.repository.findById(projectId, documentId);
  }

  create(
    projectId: string,
    actorUserId: string,
    input: DocumentCreateInput,
  ): Promise<PacaDocument> {
    return this.repository.create({
      id: crypto.randomUUID(),
      projectId,
      title: normalizeTitle(input.title),
      content: normalizeContent(input.content),
      position: normalizePosition(input.position),
      actorUserId,
    });
  }

  update(
    projectId: string,
    documentId: string,
    actorUserId: string,
    input: DocumentUpdateInput,
  ): Promise<PacaDocument> {
    const normalized: PersistedDocumentUpdate = {};
    if (input.title !== undefined) normalized.title = normalizeTitle(input.title);
    if (input.position !== undefined) normalized.position = normalizePosition(input.position);
    if (Object.keys(normalized).length === 0) {
      return this.repository.findById(projectId, documentId);
    }
    return this.repository.update(projectId, documentId, actorUserId, normalized);
  }

  archive(projectId: string, documentId: string, actorUserId: string): Promise<void> {
    return this.repository.archive(projectId, documentId, actorUserId);
  }
}
