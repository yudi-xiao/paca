import type { PermissionGrant } from "../permission/statement";

export const projectErrorCodes = {
  descriptionInvalid: "PROJECT_DESCRIPTION_INVALID",
  nameInvalid: "PROJECT_NAME_INVALID",
  nameTaken: "PROJECT_NAME_TAKEN",
  notFound: "PROJECT_NOT_FOUND",
  prefixInvalid: "PROJECT_PREFIX_INVALID",
  settingsInvalid: "PROJECT_SETTINGS_INVALID",
} as const;

export type ProjectErrorCode = (typeof projectErrorCodes)[keyof typeof projectErrorCodes];

export class ProjectError extends Error {
  constructor(
    readonly code: ProjectErrorCode,
    message = code,
  ) {
    super(message);
    this.name = "ProjectError";
  }
}

export type Project = {
  id: string;
  organizationId: string;
  name: string;
  description: string;
  taskIdPrefix: string;
  isPublic: boolean;
  settings: Record<string, unknown>;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ProjectList = {
  items: Project[];
  total: number;
  page: number;
  pageSize: number;
};

export type ProjectStats = {
  openTaskCount: number;
  teamMemberCount: number;
  aiAgentCount: number;
};

export type ProjectRoleSeed = {
  id: string;
  name: string;
  description: string;
  grants: PermissionGrant[];
};

export type PersistedProjectCreate = {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  description: string;
  taskIdPrefix: string;
  isPublic: boolean;
  settings: Record<string, unknown>;
  createdBy: string;
  defaultRoles: ProjectRoleSeed[];
  defaultTaskTypes: Array<{
    id: string;
    name: string;
    icon: string;
    color: string;
    description: string;
    isDefault: boolean;
    isSystem: boolean;
  }>;
  defaultTaskStatuses: Array<{
    id: string;
    name: string;
    color: string;
    position: number;
    category: "backlog" | "todo" | "inprogress" | "done";
    isDefault: boolean;
  }>;
};

export type PersistedProjectUpdate = Partial<
  Pick<Project, "name" | "description" | "taskIdPrefix" | "isPublic" | "settings">
>;

export type ProjectCreateInput = {
  name: string;
  description?: string;
  taskIdPrefix?: string;
  isPublic?: boolean;
  settings?: unknown;
};

export type ProjectUpdateInput = {
  name?: string;
  description?: string;
  taskIdPrefix?: string;
  isPublic?: boolean;
  settings?: unknown;
};

export interface ProjectRepository {
  list(organizationId: string, page: number, pageSize: number): Promise<ProjectList>;
  stats(organizationId: string): Promise<ProjectStats>;
  findById(projectId: string): Promise<Project>;
  create(input: PersistedProjectCreate): Promise<Project>;
  update(projectId: string, input: PersistedProjectUpdate): Promise<Project>;
  archive(projectId: string): Promise<void>;
}

const PROJECT_NAME_MAX_LENGTH = 100;
const PROJECT_DESCRIPTION_MAX_LENGTH = 2_000;
const PROJECT_PREFIX_PATTERN = /^[A-Z0-9]{1,10}$/;

function normalizeName(value: string): string {
  const name = value.trim();
  if (name.length === 0 || name.length > PROJECT_NAME_MAX_LENGTH) {
    throw new ProjectError(projectErrorCodes.nameInvalid);
  }
  return name;
}

function normalizeDescription(value: string | undefined): string {
  const description = value?.trim() ?? "";
  if (description.length > PROJECT_DESCRIPTION_MAX_LENGTH) {
    throw new ProjectError(projectErrorCodes.descriptionInvalid);
  }
  return description;
}

function suggestTaskPrefix(name: string): string {
  const words = name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9\s_-]/g, " ")
    .split(/[\s_-]+/)
    .filter(Boolean);
  if (words.length === 0) return "PROJ";
  if (words.length === 1) return words[0]?.slice(0, 4).toUpperCase() || "PROJ";
  return words
    .slice(0, 4)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}

function normalizeTaskPrefix(value: string | undefined, name: string): string {
  const prefix = value?.trim().toUpperCase() || suggestTaskPrefix(name);
  if (!PROJECT_PREFIX_PATTERN.test(prefix)) {
    throw new ProjectError(projectErrorCodes.prefixInvalid);
  }
  return prefix;
}

function normalizeSettings(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProjectError(projectErrorCodes.settingsInvalid);
  }
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    throw new ProjectError(projectErrorCodes.settingsInvalid);
  }
}

function slugForProject(name: string, projectId: string): string {
  const stem = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `${stem || "project"}-${projectId.slice(0, 8)}`;
}

function projectRoleSeeds(): ProjectRoleSeed[] {
  const nowIndependentRole = (
    name: string,
    description: string,
    grants: PermissionGrant[],
  ): ProjectRoleSeed => ({ id: crypto.randomUUID(), name, description, grants });

  return [
    nowIndependentRole("Admin", "Project administrator", [
      { resource: "projects", action: "*" },
      { resource: "projectMembers", action: "*" },
      { resource: "projectRoles", action: "*" },
      { resource: "tasks", action: "*" },
      { resource: "sprints", action: "*" },
      { resource: "docs", action: "*" },
      { resource: "agents", action: "*" },
      { resource: "environments", action: "*" },
      { resource: "workflows", action: "*" },
    ]),
    nowIndependentRole("Editor", "Project editor", [
      { resource: "projects", action: "read" },
      { resource: "projectMembers", action: "read" },
      { resource: "projectRoles", action: "read" },
      { resource: "tasks", action: "*" },
      { resource: "sprints", action: "*" },
      { resource: "docs", action: "*" },
      { resource: "agents", action: "read" },
      { resource: "agents", action: "write" },
      { resource: "environments", action: "*" },
      { resource: "workflows", action: "*" },
    ]),
    nowIndependentRole("Viewer", "Project viewer", [
      { resource: "projects", action: "read" },
      { resource: "projectMembers", action: "read" },
      { resource: "projectRoles", action: "read" },
      { resource: "tasks", action: "read" },
      { resource: "sprints", action: "read" },
      { resource: "docs", action: "read" },
      { resource: "agents", action: "read" },
      { resource: "environments", action: "read" },
      { resource: "workflows", action: "read" },
    ]),
  ];
}

function defaultTaskTypes(): PersistedProjectCreate["defaultTaskTypes"] {
  return [
    {
      id: crypto.randomUUID(),
      name: "Task",
      icon: "circle-check",
      color: "#3b82f6",
      description: "Standard project task",
      isDefault: true,
      isSystem: true,
    },
    {
      id: crypto.randomUUID(),
      name: "Bug",
      icon: "bug",
      color: "#ef4444",
      description: "Defect or unexpected behavior",
      isDefault: false,
      isSystem: true,
    },
  ];
}

function defaultTaskStatuses(): PersistedProjectCreate["defaultTaskStatuses"] {
  return [
    {
      id: crypto.randomUUID(),
      name: "Backlog",
      color: "#64748b",
      position: 0,
      category: "backlog",
      isDefault: true,
    },
    {
      id: crypto.randomUUID(),
      name: "To Do",
      color: "#3b82f6",
      position: 1,
      category: "todo",
      isDefault: false,
    },
    {
      id: crypto.randomUUID(),
      name: "In Progress",
      color: "#f59e0b",
      position: 2,
      category: "inprogress",
      isDefault: false,
    },
    {
      id: crypto.randomUUID(),
      name: "Done",
      color: "#22c55e",
      position: 3,
      category: "done",
      isDefault: false,
    },
  ];
}

export class ProjectService {
  constructor(private readonly repository: ProjectRepository) {}

  list(organizationId: string, page: number, pageSize: number): Promise<ProjectList> {
    const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
    const normalizedPageSize = Number.isInteger(pageSize)
      ? Math.min(Math.max(pageSize, 1), 100)
      : 50;
    return this.repository.list(organizationId, normalizedPage, normalizedPageSize);
  }

  stats(organizationId: string): Promise<ProjectStats> {
    return this.repository.stats(organizationId);
  }

  get(projectId: string): Promise<Project> {
    return this.repository.findById(projectId);
  }

  async create(
    organizationId: string,
    createdBy: string,
    input: ProjectCreateInput,
  ): Promise<Project> {
    const id = crypto.randomUUID();
    const name = normalizeName(input.name);
    return await this.repository.create({
      id,
      organizationId,
      name,
      slug: slugForProject(name, id),
      description: normalizeDescription(input.description),
      taskIdPrefix: normalizeTaskPrefix(input.taskIdPrefix, name),
      isPublic: input.isPublic ?? false,
      settings: normalizeSettings(input.settings),
      createdBy,
      defaultRoles: projectRoleSeeds(),
      defaultTaskTypes: defaultTaskTypes(),
      defaultTaskStatuses: defaultTaskStatuses(),
    });
  }

  async update(projectId: string, input: ProjectUpdateInput): Promise<Project> {
    const normalized: PersistedProjectUpdate = {};
    if (input.name !== undefined) normalized.name = normalizeName(input.name);
    if (input.description !== undefined) {
      normalized.description = normalizeDescription(input.description);
    }
    if (input.taskIdPrefix !== undefined) {
      normalized.taskIdPrefix = normalizeTaskPrefix(input.taskIdPrefix, input.name ?? "Project");
    }
    if (input.isPublic !== undefined) normalized.isPublic = input.isPublic;
    if (input.settings !== undefined) normalized.settings = normalizeSettings(input.settings);
    if (Object.keys(normalized).length === 0) {
      return await this.repository.findById(projectId);
    }
    return await this.repository.update(projectId, normalized);
  }

  archive(projectId: string): Promise<void> {
    return this.repository.archive(projectId);
  }
}
