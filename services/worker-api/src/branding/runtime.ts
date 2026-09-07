import type { AppBindings } from "../bindings";
import { R2BrandingObjectStore } from "./r2-store";
import { RuntimeBrandingRepository } from "./runtime-repository";
import {
  type BrandingImageObject,
  BrandingService,
  type BrandingSettings,
  type BrandingSlot,
} from "./service";

export type BrandingRuntime = {
  get(env: AppBindings): Promise<BrandingSettings>;
  initiate(
    env: AppBindings,
    slot: BrandingSlot,
    actorUserId: string,
    input: { fileName: string; contentType: string; fileSize: number },
    uploadBasePath: string,
  ): Promise<{ fileId: string; uploadUrl: string }>;
  upload(
    env: AppBindings,
    fileId: string,
    actorUserId: string,
    contentLength: number | null,
    body: ReadableStream | null,
  ): Promise<{ etag: string }>;
  complete(env: AppBindings, fileId: string, actorUserId: string): Promise<BrandingSettings>;
  remove(env: AppBindings, slot: BrandingSlot, actorUserId: string): Promise<BrandingSettings>;
  update(
    env: AppBindings,
    input: {
      brandName?: string | null;
      primaryColorLight?: string | null;
      primaryColorDark?: string | null;
    },
    actorUserId: string,
  ): Promise<BrandingSettings>;
  image(env: AppBindings, slot: BrandingSlot, fileId: string): Promise<BrandingImageObject>;
  cleanup(
    env: AppBindings,
    now?: Date,
  ): Promise<{ claimed: number; purged: number; failed: number }>;
};

function service(env: AppBindings): BrandingService {
  return new BrandingService(new RuntimeBrandingRepository(env), new R2BrandingObjectStore(env));
}

export const brandingRuntime: BrandingRuntime = {
  get: (env) => service(env).get(),
  initiate: (env, slot, actorUserId, input, uploadBasePath) =>
    service(env).initiate(slot, actorUserId, input, uploadBasePath),
  upload: (env, fileId, actorUserId, contentLength, body) =>
    service(env).upload(fileId, actorUserId, contentLength, body),
  complete: (env, fileId, actorUserId) => service(env).complete(fileId, actorUserId),
  remove: (env, slot, actorUserId) => service(env).remove(slot, actorUserId),
  update: (env, input, actorUserId) => service(env).update(input, actorUserId),
  image: (env, slot, fileId) => service(env).image(slot, fileId),
  cleanup: (env, now) => service(env).cleanup(now),
};
