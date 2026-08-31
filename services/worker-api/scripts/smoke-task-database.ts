import { readFileSync } from "node:fs";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import * as schema from "../src/db/schema";
import { user } from "../src/db/schema";
import { pacaProjects } from "../src/db/schema/paca";
import { DEFAULT_ORGANIZATION_ID } from "../src/permission/postgres-store";
import { PostgresProjectRepository } from "../src/project/postgres-repository";
import { ProjectService } from "../src/project/service";
import { PostgresTaskRepository } from "../src/task/postgres-repository";
import { TaskService } from "../src/task/service";

function databaseUrl(): string {
  const line = readFileSync(new URL("../../../.env", import.meta.url), "utf8")
    .split(/\r?\n/)
    .find((value) => value.startsWith("DATABASE_URL="));
  if (!line) throw new Error("DATABASE_URL is missing from the root .env");
  const value = line.slice("DATABASE_URL=".length).trim();
  return value.replace(/^(["'])(.*)\1$/, "$2");
}

if (process.env.PACA_ALLOW_MAIN_DATABASE_FOR_INTERNAL_PREVIEW !== "true") {
  throw new Error(
    "PACA_ALLOW_MAIN_DATABASE_FOR_INTERNAL_PREVIEW=true is required for the destructive-cleanup smoke test.",
  );
}

const client = new Client({
  connectionString: databaseUrl(),
  connectionTimeoutMillis: 8_000,
  query_timeout: 8_000,
});

await client.connect();
const database = drizzle(client, { schema });
let projectId: string | null = null;

try {
  const [actor] = await database.select({ id: user.id }).from(user).limit(1);
  if (!actor) throw new Error("TASK_SMOKE_REQUIRES_EXISTING_USER");

  const projectService = new ProjectService(new PostgresProjectRepository(database));
  const taskService = new TaskService(new PostgresTaskRepository(database));
  const project = await projectService.create(DEFAULT_ORGANIZATION_ID, actor.id, {
    name: `Task smoke ${crypto.randomUUID().slice(0, 8)}`,
    taskIdPrefix: "SMOKE",
  });
  projectId = project.id;

  const [types, statuses] = await Promise.all([
    taskService.listTypes(project.id),
    taskService.listStatuses(project.id),
  ]);
  if (types.length !== 2 || statuses.length !== 4) {
    throw new Error("TASK_SMOKE_DEFAULT_WORKFLOW_INVALID");
  }

  const task = await taskService.create(project.id, actor.id, { title: "Task smoke item" });
  if (task.taskNumber !== 1 || !task.taskTypeId || !task.statusId) {
    throw new Error("TASK_SMOKE_CREATE_INVALID");
  }
  const todo = statuses.find((status) => status.category === "todo");
  if (!todo) throw new Error("TASK_SMOKE_TODO_STATUS_MISSING");
  const updated = await taskService.update(project.id, task.id, actor.id, {
    statusId: todo.id,
  });
  if (updated.statusId !== todo.id) throw new Error("TASK_SMOKE_UPDATE_INVALID");

  const listed = await taskService.list(project.id, { search: "smoke", pageSize: 20 });
  if (listed.totalCount !== 1 || listed.items[0]?.id !== task.id) {
    throw new Error("TASK_SMOKE_LIST_INVALID");
  }
  await taskService.archive(project.id, task.id, actor.id);
  const archived = await taskService.list(project.id, { pageSize: 20 });
  if (archived.totalCount !== 0) throw new Error("TASK_SMOKE_ARCHIVE_INVALID");

  console.log(
    JSON.stringify({
      status: "ok",
      step: "task-database-smoke",
      taskTypes: types.length,
      taskStatuses: statuses.length,
      createdTaskNumber: task.taskNumber,
    }),
  );
} finally {
  if (projectId) {
    await database.delete(pacaProjects).where(eq(pacaProjects.id, projectId));
  }
  await client.end();
}
