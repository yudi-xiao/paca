import { describe, expect, it, vi } from "vitest";

import {
  ProjectEnvironmentConnectionRevoker,
  usersWithProjectEnvironmentPermissionLoss,
} from "../src/environment/project-permission-revocation";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

describe("project environment permission revocation", () => {
  it("selects only users who actually lost read or connect permission", () => {
    const before = new Map([
      ["lost-read", { read: true, connect: false }],
      ["lost-connect", { read: true, connect: true }],
      ["unchanged", { read: true, connect: true }],
      ["gained", { read: false, connect: false }],
    ]);
    const after = new Map([
      ["lost-read", { read: false, connect: false }],
      ["lost-connect", { read: true, connect: false }],
      ["unchanged", { read: true, connect: true }],
      ["gained", { read: true, connect: true }],
    ]);

    expect(usersWithProjectEnvironmentPermissionLoss(before, after)).toEqual([
      "lost-read",
      "lost-connect",
    ]);
  });

  it("deduplicates and sends project revocations in bounded batches", async () => {
    const revokeProjectConnections = vi.fn(async (_projectId: string, agentIds: string[]) => ({
      terminated: agentIds.length,
      pending: 0,
    }));
    const revoker = new ProjectEnvironmentConnectionRevoker({ revokeProjectConnections });
    const agentIds = Array.from({ length: 102 }, (_, index) => `agent-${index}`);

    await expect(revoker.revoke(PROJECT_ID, [...agentIds, "agent-0"])).resolves.toEqual({
      requested: 102,
      terminated: 102,
      pending: 0,
      failed: 0,
    });
    expect(revokeProjectConnections).toHaveBeenCalledTimes(2);
    expect(revokeProjectConnections.mock.calls[0]?.[1]).toHaveLength(100);
    expect(revokeProjectConnections.mock.calls[1]?.[1]).toHaveLength(2);
  });

  it("reports a failed batch without losing successful revocations", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const revokeProjectConnections = vi
      .fn<
        (projectId: string, agentIds: string[]) => Promise<{ terminated: number; pending: number }>
      >()
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockResolvedValueOnce({ terminated: 1, pending: 0 });
    const revoker = new ProjectEnvironmentConnectionRevoker({ revokeProjectConnections });
    const agentIds = Array.from({ length: 101 }, (_, index) => `agent-${index}`);

    await expect(revoker.revoke(PROJECT_ID, agentIds)).resolves.toEqual({
      requested: 101,
      terminated: 1,
      pending: 0,
      failed: 100,
    });
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });
});
