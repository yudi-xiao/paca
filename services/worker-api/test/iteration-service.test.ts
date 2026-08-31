import { describe, expect, it, vi } from "vitest";

import {
  type IterationRepository,
  IterationService,
  iterationErrorCodes,
  type Sprint,
  type TaskView,
} from "../src/iteration/service";

const projectId = "6bdb7f3a-e59d-4826-8383-0104192157a8";
const sprint: Sprint = {
  id: "01bd76a4-263b-4a1e-940d-b9a81760ff0c",
  projectId,
  name: "Sprint 1",
  startDate: "2026-08-28",
  endDate: "2026-09-04",
  goal: null,
  status: "planned",
  createdAt: new Date("2026-08-28T00:00:00.000Z"),
  updatedAt: new Date("2026-08-28T00:00:00.000Z"),
};
const view: TaskView = {
  id: "89d6d6e9-b50a-4c06-8fc9-74d8e90d1b16",
  sprintId: sprint.id,
  projectId,
  name: "Board",
  viewType: "board",
  viewContext: "sprint",
  config: {},
  position: 0,
  createdAt: sprint.createdAt,
  updatedAt: sprint.updatedAt,
};

function repository(overrides: Partial<IterationRepository> = {}): IterationRepository {
  return {
    listSprints: async () => [sprint],
    findSprint: async () => sprint,
    createSprint: async () => sprint,
    updateSprint: async () => sprint,
    deleteSprint: async () => undefined,
    completeSprint: async () => ({ ...sprint, status: "completed" }),
    listViews: async () => [view],
    findView: async () => view,
    createView: async () => view,
    updateView: async () => view,
    deleteView: async () => undefined,
    reorderViews: async () => undefined,
    listTaskPositions: async () => [],
    upsertTaskPositions: async () => undefined,
    ...overrides,
  };
}

describe("iteration service", () => {
  it("normalizes sprint creation and preserves date-only values", async () => {
    const createSprint = vi.fn(repository().createSprint);
    const service = new IterationService(repository({ createSprint }));
    await service.createSprint(projectId, {
      name: " Sprint 1 ",
      startDate: "2026-08-28",
      endDate: "2026-09-04",
      goal: " Ship the slice ",
    });
    expect(createSprint).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        name: "Sprint 1",
        startDate: "2026-08-28",
        endDate: "2026-09-04",
        goal: "Ship the slice",
        status: "planned",
      }),
    );
  });

  it("rejects inverted sprint dates and self completion destinations", () => {
    const service = new IterationService(repository());
    expect(() =>
      service.createSprint(projectId, {
        name: "Sprint",
        startDate: "2026-09-04",
        endDate: "2026-08-28",
      }),
    ).toThrowError(expect.objectContaining({ code: iterationErrorCodes.dateInvalid }));
    expect(() => service.completeSprint(projectId, sprint.id, sprint.id, "user-1")).toThrowError(
      expect.objectContaining({ code: iterationErrorCodes.destinationInvalid }),
    );
  });

  it("requires sprint context to carry a sprint and validates plugin bindings", () => {
    const service = new IterationService(repository());
    expect(() => service.listViews(projectId, "sprint", null)).toThrowError(
      expect.objectContaining({ code: iterationErrorCodes.viewContextInvalid }),
    );
    expect(() =>
      service.createView(projectId, "backlog", null, {
        name: "Extension",
        viewType: "plugin",
        config: {},
      }),
    ).toThrowError(expect.objectContaining({ code: iterationErrorCodes.viewConfigInvalid }));
  });

  it("rejects duplicate manual positions in one atomic request", () => {
    const service = new IterationService(repository());
    expect(() =>
      service.upsertTaskPositions(projectId, view.id, [
        { taskId: sprint.id, position: 0 },
        { taskId: sprint.id, position: 1 },
      ]),
    ).toThrowError(expect.objectContaining({ code: iterationErrorCodes.taskPositionInvalid }));
  });
});
