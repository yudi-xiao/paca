import { and, asc, eq, isNull, sql } from "drizzle-orm";

import type { PacaDatabase } from "../database";
import { pacaDocuments } from "../db/schema";
import {
  DocumentError,
  type DocumentRepository,
  documentErrorCodes,
  type PacaDocument,
  type PersistedDocumentCreate,
  type PersistedDocumentUpdate,
} from "./service";

type DocumentRow = typeof pacaDocuments.$inferSelect;

function fromRow(row: DocumentRow): PacaDocument {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    content: row.content ?? null,
    contentVersion: row.contentVersion,
    position: row.position,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PostgresDocumentRepository implements DocumentRepository {
  constructor(private readonly database: PacaDatabase) {}

  async list(projectId: string): Promise<PacaDocument[]> {
    const rows = await this.database
      .select()
      .from(pacaDocuments)
      .where(and(eq(pacaDocuments.projectId, projectId), isNull(pacaDocuments.deletedAt)))
      .orderBy(asc(pacaDocuments.position), asc(pacaDocuments.title), asc(pacaDocuments.id));
    return rows.map(fromRow);
  }

  async findById(projectId: string, documentId: string): Promise<PacaDocument> {
    const [row] = await this.database
      .select()
      .from(pacaDocuments)
      .where(
        and(
          eq(pacaDocuments.id, documentId),
          eq(pacaDocuments.projectId, projectId),
          isNull(pacaDocuments.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new DocumentError(documentErrorCodes.notFound);
    return fromRow(row);
  }

  async create(input: PersistedDocumentCreate): Promise<PacaDocument> {
    const [row] = await this.database
      .insert(pacaDocuments)
      .values({
        id: input.id,
        projectId: input.projectId,
        title: input.title,
        content: input.content,
        position: input.position,
        createdBy: input.actorUserId,
        updatedBy: input.actorUserId,
      })
      .returning();
    if (!row) throw new Error("DOCUMENT_CREATE_FAILED");
    return fromRow(row);
  }

  async update(
    projectId: string,
    documentId: string,
    actorUserId: string,
    input: PersistedDocumentUpdate,
  ): Promise<PacaDocument> {
    const [row] = await this.database
      .update(pacaDocuments)
      .set({
        updatedBy: actorUserId,
        updatedAt: new Date(),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.position !== undefined ? { position: input.position } : {}),
        ...(input.content !== undefined
          ? {
              content: input.content,
              contentVersion: sql`${pacaDocuments.contentVersion} + 1`,
            }
          : {}),
      })
      .where(
        and(
          eq(pacaDocuments.id, documentId),
          eq(pacaDocuments.projectId, projectId),
          isNull(pacaDocuments.deletedAt),
        ),
      )
      .returning();
    if (!row) throw new DocumentError(documentErrorCodes.notFound);
    return fromRow(row);
  }

  async archive(projectId: string, documentId: string, actorUserId: string): Promise<void> {
    const [row] = await this.database
      .update(pacaDocuments)
      .set({ deletedAt: new Date(), updatedAt: new Date(), updatedBy: actorUserId })
      .where(
        and(
          eq(pacaDocuments.id, documentId),
          eq(pacaDocuments.projectId, projectId),
          isNull(pacaDocuments.deletedAt),
        ),
      )
      .returning({ id: pacaDocuments.id });
    if (!row) throw new DocumentError(documentErrorCodes.notFound);
  }
}
