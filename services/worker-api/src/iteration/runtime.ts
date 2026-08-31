import type { AppBindings } from "../bindings";
import { withDatabase } from "../database";
import { PostgresIterationRepository } from "./postgres-repository";
import {
  IterationService,
  type Sprint,
  type SprintCreateInput,
  type SprintUpdateInput,
  type TaskPositionInput,
  type TaskView,
  type ViewContext,
  type ViewCreateInput,
  type ViewTaskPosition,
  type ViewUpdateInput,
} from "./service";

export type IterationRuntime = {
  listSprints(env: AppBindings, projectId: string): Promise<Sprint[]>;
  getSprint(env: AppBindings, projectId: string, sprintId: string): Promise<Sprint>;
  createSprint(env: AppBindings, projectId: string, input: SprintCreateInput): Promise<Sprint>;
  updateSprint(
    env: AppBindings,
    projectId: string,
    sprintId: string,
    input: SprintUpdateInput,
  ): Promise<Sprint>;
  deleteSprint(
    env: AppBindings,
    projectId: string,
    sprintId: string,
    actorUserId: string,
  ): Promise<void>;
  completeSprint(
    env: AppBindings,
    projectId: string,
    sprintId: string,
    destinationSprintId: string | null,
    actorUserId: string,
  ): Promise<Sprint>;
  listViews(
    env: AppBindings,
    projectId: string,
    context: ViewContext,
    sprintId: string | null,
  ): Promise<TaskView[]>;
  getView(env: AppBindings, projectId: string, viewId: string): Promise<TaskView>;
  createView(
    env: AppBindings,
    projectId: string,
    context: ViewContext,
    sprintId: string | null,
    input: ViewCreateInput,
  ): Promise<TaskView>;
  updateView(
    env: AppBindings,
    projectId: string,
    viewId: string,
    input: ViewUpdateInput,
  ): Promise<TaskView>;
  deleteView(env: AppBindings, projectId: string, viewId: string): Promise<void>;
  reorderViews(
    env: AppBindings,
    projectId: string,
    context: ViewContext,
    sprintId: string | null,
    viewIds: string[],
  ): Promise<void>;
  listTaskPositions(
    env: AppBindings,
    projectId: string,
    viewId: string,
  ): Promise<ViewTaskPosition[]>;
  upsertTaskPositions(
    env: AppBindings,
    projectId: string,
    viewId: string,
    items: TaskPositionInput[],
  ): Promise<void>;
};

function withService<T>(
  env: AppBindings,
  operation: (service: IterationService) => Promise<T>,
): Promise<T> {
  return withDatabase(env, (database) =>
    operation(new IterationService(new PostgresIterationRepository(database))),
  );
}

export const iterationRuntime: IterationRuntime = {
  listSprints: (env, projectId) => withService(env, (service) => service.listSprints(projectId)),
  getSprint: (env, projectId, sprintId) =>
    withService(env, (service) => service.getSprint(projectId, sprintId)),
  createSprint: (env, projectId, input) =>
    withService(env, (service) => service.createSprint(projectId, input)),
  updateSprint: (env, projectId, sprintId, input) =>
    withService(env, (service) => service.updateSprint(projectId, sprintId, input)),
  deleteSprint: (env, projectId, sprintId, actorUserId) =>
    withService(env, (service) => service.deleteSprint(projectId, sprintId, actorUserId)),
  completeSprint: (env, projectId, sprintId, destinationSprintId, actorUserId) =>
    withService(env, (service) =>
      service.completeSprint(projectId, sprintId, destinationSprintId, actorUserId),
    ),
  listViews: (env, projectId, context, sprintId) =>
    withService(env, (service) => service.listViews(projectId, context, sprintId)),
  getView: (env, projectId, viewId) =>
    withService(env, (service) => service.getView(projectId, viewId)),
  createView: (env, projectId, context, sprintId, input) =>
    withService(env, (service) => service.createView(projectId, context, sprintId, input)),
  updateView: (env, projectId, viewId, input) =>
    withService(env, (service) => service.updateView(projectId, viewId, input)),
  deleteView: (env, projectId, viewId) =>
    withService(env, (service) => service.deleteView(projectId, viewId)),
  reorderViews: (env, projectId, context, sprintId, viewIds) =>
    withService(env, (service) => service.reorderViews(projectId, context, sprintId, viewIds)),
  listTaskPositions: (env, projectId, viewId) =>
    withService(env, (service) => service.listTaskPositions(projectId, viewId)),
  upsertTaskPositions: (env, projectId, viewId, items) =>
    withService(env, (service) => service.upsertTaskPositions(projectId, viewId, items)),
};
