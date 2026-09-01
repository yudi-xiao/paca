import { describe, expect, it } from "vitest";

import { realtimePermissionVersion } from "../src/realtime/permission-version";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";

describe("realtime permission version", () => {
  it("is stable across ordering and duplicates", async () => {
    const first = await realtimePermissionVersion({
      actorType: "user",
      actorId: "user-1",
      sessionId: "session-1",
      roomType: "project",
      roomId: PROJECT_ID,
      namespaces: ["docs", "tasks"],
      taskIds: [TASK_ID, TASK_ID],
      documentIds: [],
    });
    const second = await realtimePermissionVersion({
      actorType: "user",
      actorId: "user-1",
      sessionId: "session-1",
      roomType: "project",
      roomId: PROJECT_ID,
      namespaces: ["tasks", "docs"],
      taskIds: [TASK_ID],
      documentIds: [],
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes when the trusted session or permission scope changes", async () => {
    const base = {
      actorType: "user" as const,
      actorId: "user-1",
      sessionId: "session-1",
      roomType: "project" as const,
      roomId: PROJECT_ID,
      namespaces: ["tasks"] as const,
      taskIds: [] as const,
      documentIds: [] as const,
    };

    const version = await realtimePermissionVersion(base);
    await expect(realtimePermissionVersion({ ...base, sessionId: "session-2" })).resolves.not.toBe(
      version,
    );
    await expect(
      realtimePermissionVersion({ ...base, namespaces: ["tasks", "docs"] }),
    ).resolves.not.toBe(version);
  });
});
