import { and, asc, desc, eq, isNull } from "drizzle-orm";

import type { PacaDatabase } from "../database";
import { pacaEnvironmentScopes, pacaProjects } from "../db/schema";
import {
  type EnvironmentResource,
  EnvironmentResourceError,
  type EnvironmentResourceRepository,
  type EnvironmentScope,
  environmentResourceErrorCodes,
  type PersistedEnvironmentCreate,
} from "./service";

type EnvironmentRow = typeof pacaEnvironmentScopes.$inferSelect;

function resourceFromRow(row: EnvironmentRow): EnvironmentResource {
  return {
    id: row.environmentId,
    projectId: row.projectId,
    name: row.name,
    backend: row.backend,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isEnvironmentNameTaken(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    const candidate = current as { cause?: unknown; code?: unknown; constraint?: unknown };
    if (
      candidate.code === "23505" &&
      candidate.constraint === "paca_environment_scope_project_name_uidx"
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

export class PostgresEnvironmentScopeRepository implements EnvironmentResourceRepository {
  constructor(private readonly database: PacaDatabase) {}

  async find(environmentId: string): Promise<EnvironmentScope | null> {
    const [row] = await this.database
      .select({
        environmentId: pacaEnvironmentScopes.environmentId,
        organizationId: pacaProjects.organizationId,
        projectId: pacaEnvironmentScopes.projectId,
        backend: pacaEnvironmentScopes.backend,
        gatewayReference: pacaEnvironmentScopes.gatewayReference,
      })
      .from(pacaEnvironmentScopes)
      .innerJoin(pacaProjects, eq(pacaProjects.id, pacaEnvironmentScopes.projectId))
      .where(
        and(
          eq(pacaEnvironmentScopes.environmentId, environmentId),
          isNull(pacaEnvironmentScopes.deletedAt),
          eq(pacaProjects.status, "active"),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async list(projectId: string): Promise<EnvironmentResource[]> {
    const rows = await this.database
      .select({ environment: pacaEnvironmentScopes })
      .from(pacaEnvironmentScopes)
      .innerJoin(pacaProjects, eq(pacaProjects.id, pacaEnvironmentScopes.projectId))
      .where(
        and(
          eq(pacaEnvironmentScopes.projectId, projectId),
          isNull(pacaEnvironmentScopes.deletedAt),
          eq(pacaProjects.status, "active"),
        ),
      )
      .orderBy(desc(pacaEnvironmentScopes.createdAt), asc(pacaEnvironmentScopes.name));
    return rows.map(({ environment }) => resourceFromRow(environment));
  }

  async findResource(projectId: string, environmentId: string): Promise<EnvironmentResource> {
    const [row] = await this.database
      .select({ environment: pacaEnvironmentScopes })
      .from(pacaEnvironmentScopes)
      .innerJoin(pacaProjects, eq(pacaProjects.id, pacaEnvironmentScopes.projectId))
      .where(
        and(
          eq(pacaEnvironmentScopes.environmentId, environmentId),
          eq(pacaEnvironmentScopes.projectId, projectId),
          isNull(pacaEnvironmentScopes.deletedAt),
          eq(pacaProjects.status, "active"),
        ),
      )
      .limit(1);
    if (!row) throw new EnvironmentResourceError(environmentResourceErrorCodes.notFound);
    return resourceFromRow(row.environment);
  }

  async create(input: PersistedEnvironmentCreate): Promise<EnvironmentResource> {
    try {
      return await this.database.transaction(async (transaction) => {
        const [project] = await transaction
          .select({ id: pacaProjects.id })
          .from(pacaProjects)
          .where(and(eq(pacaProjects.id, input.projectId), eq(pacaProjects.status, "active")))
          .limit(1);
        if (!project) throw new EnvironmentResourceError(environmentResourceErrorCodes.notFound);
        const [row] = await transaction
          .insert(pacaEnvironmentScopes)
          .values({
            environmentId: input.id,
            projectId: input.projectId,
            name: input.name,
            backend: input.backend,
            gatewayReference: input.gatewayReference,
            createdBy: input.createdBy,
            createdAt: input.createdAt,
            updatedAt: input.updatedAt,
          })
          .returning();
        if (!row) throw new Error("ENVIRONMENT_CREATE_FAILED");
        return resourceFromRow(row);
      });
    } catch (error) {
      if (isEnvironmentNameTaken(error)) {
        throw new EnvironmentResourceError(environmentResourceErrorCodes.nameTaken);
      }
      throw error;
    }
  }

  async update(
    projectId: string,
    environmentId: string,
    input: { name?: string },
  ): Promise<EnvironmentResource> {
    try {
      return await this.database.transaction(async (transaction) => {
        const [current] = await transaction
          .select({ environment: pacaEnvironmentScopes })
          .from(pacaEnvironmentScopes)
          .innerJoin(pacaProjects, eq(pacaProjects.id, pacaEnvironmentScopes.projectId))
          .where(
            and(
              eq(pacaEnvironmentScopes.environmentId, environmentId),
              eq(pacaEnvironmentScopes.projectId, projectId),
              isNull(pacaEnvironmentScopes.deletedAt),
              eq(pacaProjects.status, "active"),
            ),
          )
          .for("update")
          .limit(1);
        if (!current) throw new EnvironmentResourceError(environmentResourceErrorCodes.notFound);
        const [row] = await transaction
          .update(pacaEnvironmentScopes)
          .set({ ...input, updatedAt: new Date() })
          .where(
            and(
              eq(pacaEnvironmentScopes.environmentId, environmentId),
              eq(pacaEnvironmentScopes.projectId, projectId),
              isNull(pacaEnvironmentScopes.deletedAt),
            ),
          )
          .returning();
        if (!row) throw new EnvironmentResourceError(environmentResourceErrorCodes.notFound);
        return resourceFromRow(row);
      });
    } catch (error) {
      if (isEnvironmentNameTaken(error)) {
        throw new EnvironmentResourceError(environmentResourceErrorCodes.nameTaken);
      }
      throw error;
    }
  }

  async archive(projectId: string, environmentId: string): Promise<void> {
    const now = new Date();
    const [row] = await this.database
      .update(pacaEnvironmentScopes)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(pacaEnvironmentScopes.environmentId, environmentId),
          eq(pacaEnvironmentScopes.projectId, projectId),
          isNull(pacaEnvironmentScopes.deletedAt),
        ),
      )
      .returning({ id: pacaEnvironmentScopes.environmentId });
    if (row) return;

    // Archive is intentionally idempotent so a caller can retry the Gateway
    // revocation barrier after the database write has already committed.
    const [existing] = await this.database
      .select({ id: pacaEnvironmentScopes.environmentId })
      .from(pacaEnvironmentScopes)
      .where(
        and(
          eq(pacaEnvironmentScopes.environmentId, environmentId),
          eq(pacaEnvironmentScopes.projectId, projectId),
        ),
      )
      .limit(1);
    if (!existing) throw new EnvironmentResourceError(environmentResourceErrorCodes.notFound);
  }
}
