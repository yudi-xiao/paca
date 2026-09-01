import type { AppBindings } from "../bindings";

type RealtimeInvalidationStub = {
  invalidateActor(actorType: "user" | "agent", actorId: string): Promise<number>;
  invalidateSession(sessionId: string): Promise<number>;
  invalidateAll(): Promise<number>;
};

type RealtimeNamespace = {
  getByName(name: string): RealtimeInvalidationStub;
};

function projectParty(env: AppBindings): RealtimeNamespace | null {
  return (
    ((env as Partial<AppBindings>).ProjectParty as unknown as RealtimeNamespace | undefined) ?? null
  );
}

function userParty(env: AppBindings): RealtimeNamespace | null {
  return (
    ((env as Partial<AppBindings>).UserParty as unknown as RealtimeNamespace | undefined) ?? null
  );
}

export async function invalidateProjectActor(
  env: AppBindings,
  projectId: string,
  actorType: "user" | "agent",
  actorId: string,
): Promise<number> {
  return (await projectParty(env)?.getByName(projectId).invalidateActor(actorType, actorId)) ?? 0;
}

export async function invalidateProjectSession(
  env: AppBindings,
  projectId: string,
  sessionId: string,
): Promise<number> {
  return (await projectParty(env)?.getByName(projectId).invalidateSession(sessionId)) ?? 0;
}

export async function invalidateProjectRoom(env: AppBindings, projectId: string): Promise<number> {
  return (await projectParty(env)?.getByName(projectId).invalidateAll()) ?? 0;
}

export async function invalidateUserSession(
  env: AppBindings,
  userId: string,
  sessionId: string,
): Promise<number> {
  return (await userParty(env)?.getByName(userId).invalidateSession(sessionId)) ?? 0;
}
