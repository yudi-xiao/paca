import { and, asc, eq, sql } from "drizzle-orm";

import type { PacaDatabase } from "../database";
import { pacaCustomFieldDefinitions, pacaProjects, pacaTasks } from "../db/schema";
import {
  type CustomFieldDefinition,
  CustomFieldError,
  type CustomFieldRepository,
  type CustomFieldType,
  type CustomFieldUpdateInput,
  customFieldErrorCodes,
  type PersistedCustomFieldCreate,
} from "./service";

type CustomFieldRow = typeof pacaCustomFieldDefinitions.$inferSelect;

function fromRow(row: CustomFieldRow): CustomFieldDefinition {
  return {
    id: row.id,
    projectId: row.projectId,
    fieldKey: row.fieldKey,
    displayName: row.displayName,
    fieldType: row.fieldType as CustomFieldType,
    options: row.options,
    isRequired: row.isRequired,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export class PostgresCustomFieldRepository implements CustomFieldRepository {
  constructor(private readonly database: PacaDatabase) {}

  async list(projectId: string): Promise<CustomFieldDefinition[]> {
    const rows = await this.database
      .select()
      .from(pacaCustomFieldDefinitions)
      .where(eq(pacaCustomFieldDefinitions.projectId, projectId))
      .orderBy(asc(pacaCustomFieldDefinitions.displayName), asc(pacaCustomFieldDefinitions.id));
    return rows.map(fromRow);
  }

  async findById(projectId: string, fieldId: string): Promise<CustomFieldDefinition> {
    const [row] = await this.database
      .select()
      .from(pacaCustomFieldDefinitions)
      .where(
        and(
          eq(pacaCustomFieldDefinitions.id, fieldId),
          eq(pacaCustomFieldDefinitions.projectId, projectId),
        ),
      )
      .limit(1);
    if (!row) throw new CustomFieldError(customFieldErrorCodes.notFound);
    return fromRow(row);
  }

  async create(input: PersistedCustomFieldCreate): Promise<CustomFieldDefinition> {
    try {
      return await this.database.transaction(async (transaction) => {
        const [project] = await transaction
          .select({ id: pacaProjects.id })
          .from(pacaProjects)
          .where(and(eq(pacaProjects.id, input.projectId), eq(pacaProjects.status, "active")))
          .limit(1);
        if (!project) throw new CustomFieldError(customFieldErrorCodes.notFound);
        const [row] = await transaction
          .insert(pacaCustomFieldDefinitions)
          .values(input)
          .returning();
        if (!row) throw new Error("CUSTOM_FIELD_CREATE_FAILED");
        return fromRow(row);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new CustomFieldError(customFieldErrorCodes.keyTaken);
      }
      throw error;
    }
  }

  async update(
    projectId: string,
    fieldId: string,
    input: CustomFieldUpdateInput,
  ): Promise<CustomFieldDefinition> {
    const [row] = await this.database
      .update(pacaCustomFieldDefinitions)
      .set({ ...input, updatedAt: new Date() })
      .where(
        and(
          eq(pacaCustomFieldDefinitions.id, fieldId),
          eq(pacaCustomFieldDefinitions.projectId, projectId),
        ),
      )
      .returning();
    if (!row) throw new CustomFieldError(customFieldErrorCodes.notFound);
    return fromRow(row);
  }

  async delete(projectId: string, fieldId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const [field] = await transaction
        .select({ fieldKey: pacaCustomFieldDefinitions.fieldKey })
        .from(pacaCustomFieldDefinitions)
        .where(
          and(
            eq(pacaCustomFieldDefinitions.id, fieldId),
            eq(pacaCustomFieldDefinitions.projectId, projectId),
          ),
        )
        .for("update")
        .limit(1);
      if (!field) throw new CustomFieldError(customFieldErrorCodes.notFound);

      await transaction
        .update(pacaTasks)
        .set({
          customFields: sql`${pacaTasks.customFields} - ${field.fieldKey}`,
          updatedAt: new Date(),
        })
        .where(eq(pacaTasks.projectId, projectId));
      await transaction
        .delete(pacaCustomFieldDefinitions)
        .where(
          and(
            eq(pacaCustomFieldDefinitions.id, fieldId),
            eq(pacaCustomFieldDefinitions.projectId, projectId),
          ),
        );
    });
  }
}
