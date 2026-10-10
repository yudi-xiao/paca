import type { AgentSession } from "@better-auth/agent-auth";
import { recordAgentAuthEvent } from "../agent-auth/audit";
import type { AppBindings } from "../bindings";
import { withDatabase } from "../database";
import { PostgresPacaPermissionStore } from "../permission/postgres-store";
import { PacaPermissionService } from "../permission/service";
import { agentSearchIds } from "./agent-scope";
import { PostgresProjectSearchRepository } from "./postgres-repository";
import {
  ProjectSearchError,
  type ProjectSearchInput,
  ProjectSearchService,
  type SearchPage,
} from "./service";

export type ProjectSearchRuntime = {
  user(env: AppBindings, input: ProjectSearchInput): Promise<SearchPage>;
  agent(env: AppBindings, session: AgentSession, input: ProjectSearchInput): Promise<SearchPage>;
};
export const projectSearchRuntime: ProjectSearchRuntime = {
  user: (env, input) =>
    withDatabase(env, (database) =>
      new ProjectSearchService(new PostgresProjectSearchRepository(database)).search(input),
    ),
  agent: (env, session, input) =>
    withDatabase(env, async (database) => {
      const started = performance.now();
      const store = new PostgresPacaPermissionStore(database);
      const organizationId = await store.findProjectOrganization(input.projectId);
      if (!organizationId) throw new ProjectSearchError("SEARCH_SCOPE_DENIED");
      const ids = agentSearchIds(session, input.projectId, organizationId, input.kind);
      if (session.type !== "autonomous") {
        if (!session.userId) throw new ProjectSearchError("SEARCH_SCOPE_DENIED");
        const decision = await new PacaPermissionService(store).hasProjectPermission(
          session.userId,
          input.projectId,
          input.kind === "tasks" ? { tasks: ["read"] } : { docs: ["read"] },
        );
        if (!decision.scopeExists || !decision.allowed)
          throw new ProjectSearchError("SEARCH_SCOPE_DENIED");
      }
      const page = await new ProjectSearchService(
        new PostgresProjectSearchRepository(database),
      ).search(input, ids);
      await recordAgentAuthEvent(database, {
        type: "capability.executed",
        capability: input.kind === "tasks" ? "task.read" : "document.read",
        status: "success",
        agentId: session.agentId,
        hostId: session.host?.id,
        agentName: session.agent.name,
        ...(session.userId ? { userId: session.userId } : {}),
        provider: "paca",
        arguments: { organizationId, projectId: input.projectId, action: "search" },
        output: { count: page.items.length },
        durationMs: Math.max(0, Math.round(performance.now() - started)),
      });
      return page;
    }),
};
