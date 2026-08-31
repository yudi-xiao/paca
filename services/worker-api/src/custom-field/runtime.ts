import type { AppBindings } from "../bindings";
import { withDatabase } from "../database";
import { PostgresCustomFieldRepository } from "./postgres-repository";
import {
  type CustomFieldCreateInput,
  type CustomFieldDefinition,
  CustomFieldService,
  type CustomFieldUpdateInput,
} from "./service";

export type CustomFieldRuntime = {
  list(env: AppBindings, projectId: string): Promise<CustomFieldDefinition[]>;
  get(env: AppBindings, projectId: string, fieldId: string): Promise<CustomFieldDefinition>;
  create(
    env: AppBindings,
    projectId: string,
    input: CustomFieldCreateInput,
  ): Promise<CustomFieldDefinition>;
  update(
    env: AppBindings,
    projectId: string,
    fieldId: string,
    input: CustomFieldUpdateInput,
  ): Promise<CustomFieldDefinition>;
  delete(env: AppBindings, projectId: string, fieldId: string): Promise<void>;
};

function withService<T>(
  env: AppBindings,
  operation: (service: CustomFieldService) => Promise<T>,
): Promise<T> {
  return withDatabase(env, (database) =>
    operation(new CustomFieldService(new PostgresCustomFieldRepository(database))),
  );
}

export const customFieldRuntime: CustomFieldRuntime = {
  list: (env, projectId) => withService(env, (service) => service.list(projectId)),
  get: (env, projectId, fieldId) => withService(env, (service) => service.get(projectId, fieldId)),
  create: (env, projectId, input) =>
    withService(env, (service) => service.create(projectId, input)),
  update: (env, projectId, fieldId, input) =>
    withService(env, (service) => service.update(projectId, fieldId, input)),
  delete: (env, projectId, fieldId) =>
    withService(env, (service) => service.delete(projectId, fieldId)),
};
