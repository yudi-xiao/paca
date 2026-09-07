import type { AppBindings } from "../bindings";
import { withDatabase } from "../database";
import { PostgresBrandingRepository } from "./postgres-repository";
import type { BrandingRepository, BrandingSettings, BrandingSlot, BrandingUpload } from "./service";

export class RuntimeBrandingRepository implements BrandingRepository {
  constructor(private readonly env: AppBindings) {}

  get(): Promise<BrandingSettings> {
    return this.withRepository((repository) => repository.get());
  }

  createPending(
    input: Parameters<BrandingRepository["createPending"]>[0],
  ): Promise<BrandingUpload> {
    return this.withRepository((repository) => repository.createPending(input));
  }

  findForUpload(id: string, uploadedBy: string): Promise<BrandingUpload> {
    return this.withRepository((repository) => repository.findForUpload(id, uploadedBy));
  }

  markUploaded(
    id: string,
    uploadedBy: string,
    inspection: { actualSize: number; etag: string },
  ): Promise<BrandingUpload> {
    return this.withRepository((repository) => repository.markUploaded(id, uploadedBy, inspection));
  }

  activate(id: string, uploadedBy: string, now: Date): Promise<BrandingSettings> {
    return this.withRepository((repository) => repository.activate(id, uploadedBy, now));
  }

  clear(slot: BrandingSlot, updatedBy: string, now: Date): Promise<BrandingSettings> {
    return this.withRepository((repository) => repository.clear(slot, updatedBy, now));
  }

  update(
    input: Parameters<BrandingRepository["update"]>[0],
    updatedBy: string,
    now: Date,
  ): Promise<BrandingSettings> {
    return this.withRepository((repository) => repository.update(input, updatedBy, now));
  }

  findActiveImage(slot: BrandingSlot, fileId: string): Promise<BrandingUpload> {
    return this.withRepository((repository) => repository.findActiveImage(slot, fileId));
  }

  claimCleanup(
    now: Date,
    abandonedBefore: Date,
    staleBefore: Date,
    limit: number,
  ): Promise<BrandingUpload[]> {
    return this.withRepository((repository) =>
      repository.claimCleanup(now, abandonedBefore, staleBefore, limit),
    );
  }

  completeCleanup(ids: string[], claimedAt: Date): Promise<void> {
    return this.withRepository((repository) => repository.completeCleanup(ids, claimedAt));
  }

  releaseCleanup(ids: string[], claimedAt: Date): Promise<void> {
    return this.withRepository((repository) => repository.releaseCleanup(ids, claimedAt));
  }

  private withRepository<T>(
    operation: (repository: PostgresBrandingRepository) => Promise<T>,
  ): Promise<T> {
    return withDatabase(this.env, (database) =>
      operation(new PostgresBrandingRepository(database)),
    );
  }
}
