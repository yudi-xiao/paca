import { and, eq, isNull } from "drizzle-orm";

import type { AppBindings } from "../bindings";
import { withDatabase } from "../database";
import { pacaDocuments, pacaProjects } from "../db/schema";

export type DocumentScope = {
  documentId: string;
  organizationId: string;
  projectId: string;
};

export async function readDocumentScope(
  env: AppBindings,
  documentId: string,
): Promise<DocumentScope | null> {
  return withDatabase(env, async (database) => {
    const [scope] = await database
      .select({
        documentId: pacaDocuments.id,
        organizationId: pacaProjects.organizationId,
        projectId: pacaDocuments.projectId,
      })
      .from(pacaDocuments)
      .innerJoin(pacaProjects, eq(pacaProjects.id, pacaDocuments.projectId))
      .where(
        and(
          eq(pacaDocuments.id, documentId),
          isNull(pacaDocuments.deletedAt),
          eq(pacaProjects.status, "active"),
        ),
      )
      .limit(1);

    return scope ?? null;
  });
}
