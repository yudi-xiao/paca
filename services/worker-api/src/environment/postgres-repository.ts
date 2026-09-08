import { and, eq, isNull } from "drizzle-orm";

import type { PacaDatabase } from "../database";
import { pacaEnvironmentScopes, pacaProjects } from "../db/schema";
import type { EnvironmentScope, EnvironmentScopeRepository } from "./service";

export class PostgresEnvironmentScopeRepository implements EnvironmentScopeRepository {
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
}
