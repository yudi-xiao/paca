import type { AppBindings } from "../bindings";
import { withDatabase } from "../database";
import { PostgresProjectAgentDirectoryRepository } from "./postgres-repository";
import { type ProjectAgentDirectoryItem, ProjectAgentDirectoryService } from "./service";

export type ProjectAgentDirectoryRuntime = {
  list(env: AppBindings, projectId: string): Promise<ProjectAgentDirectoryItem[]>;
};

export const projectAgentDirectoryRuntime: ProjectAgentDirectoryRuntime = {
  list: (env, projectId) =>
    withDatabase(env, (database) =>
      new ProjectAgentDirectoryService(new PostgresProjectAgentDirectoryRepository(database)).list(
        projectId,
      ),
    ),
};
