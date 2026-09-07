import type { AppBindings } from "../bindings";
import { withDatabase } from "../database";
import { PostgresNotificationRepository } from "./postgres-repository";
import { type NotificationPage, NotificationService } from "./service";

export type NotificationRuntime = {
  list(
    env: AppBindings,
    userId: string,
    input: { pageSize?: number; cursor?: string },
  ): Promise<NotificationPage>;
  markAsRead(env: AppBindings, userId: string, notificationId: string): Promise<void>;
  markAllAsRead(env: AppBindings, userId: string): Promise<void>;
};

function withService<T>(
  env: AppBindings,
  operation: (service: NotificationService) => Promise<T>,
): Promise<T> {
  return withDatabase(env, (database) =>
    operation(new NotificationService(new PostgresNotificationRepository(database))),
  );
}

export const notificationRuntime: NotificationRuntime = {
  list: (env, userId, input) => withService(env, (service) => service.list(userId, input)),
  markAsRead: (env, userId, notificationId) =>
    withService(env, (service) => service.markAsRead(userId, notificationId)),
  markAllAsRead: (env, userId) => withService(env, (service) => service.markAllAsRead(userId)),
};
