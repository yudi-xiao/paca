import type { AppBindings } from "../bindings";
import { withDatabase } from "../database";
import { PostgresPacaPermissionStore } from "../permission/postgres-store";
import { PacaPermissionService } from "../permission/service";
import { PostgresAssignedTaskRepository } from "./assigned-postgres-repository";
import { type AssignedTaskPage, AssignedTaskService } from "./assigned-service";

export type AssignedTaskRuntime = {
  list(
    env: AppBindings,
    userId: string,
    input: { pageSize?: number; cursor?: string },
  ): Promise<AssignedTaskPage>;
};

export const assignedTaskRuntime: AssignedTaskRuntime = {
  list: (env, userId, input) =>
    withDatabase(env, async (database) => {
      const permissions = new PacaPermissionService(new PostgresPacaPermissionStore(database));
      return new AssignedTaskService(
        new PostgresAssignedTaskRepository(database),
        (actorId, projectIds) =>
          permissions.hasProjectPermissions(actorId, projectIds, { tasks: ["read"] }),
      ).list(userId, input);
    }),
};
