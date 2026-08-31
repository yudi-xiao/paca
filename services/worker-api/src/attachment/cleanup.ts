import type { AttachmentFile } from "./service";

export const ATTACHMENT_CLEANUP_BATCH_SIZE = 50;
export const ATTACHMENT_CLEANUP_CLAIM_STALE_MS = 15 * 60 * 1_000;
export const FAILED_UPLOAD_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const PENDING_UPLOAD_RETENTION_MS = 8 * 24 * 60 * 60 * 1_000;

export type AttachmentCleanupRepository = {
  claimDeleted(now: Date, staleBefore: Date, limit: number): Promise<AttachmentFile[]>;
  claimAbandoned(
    now: Date,
    failedBefore: Date,
    pendingBefore: Date,
    staleBefore: Date,
    limit: number,
  ): Promise<AttachmentFile[]>;
  complete(fileIds: string[], claimedAt: Date): Promise<void>;
  release(fileIds: string[], claimedAt: Date): Promise<void>;
};

export type AttachmentCleanupObjectStore = {
  delete(file: AttachmentFile): Promise<void>;
};

export type AttachmentCleanupResult = {
  claimed: number;
  purged: number;
  failed: number;
};

export class AttachmentCleanupService {
  constructor(
    private readonly repository: AttachmentCleanupRepository,
    private readonly objects: AttachmentCleanupObjectStore,
  ) {}

  async run(now = new Date()): Promise<AttachmentCleanupResult> {
    const staleBefore = new Date(now.getTime() - ATTACHMENT_CLEANUP_CLAIM_STALE_MS);
    const perKindLimit = Math.floor(ATTACHMENT_CLEANUP_BATCH_SIZE / 2);
    const [deleted, abandoned] = await Promise.all([
      this.repository.claimDeleted(now, staleBefore, perKindLimit),
      this.repository.claimAbandoned(
        now,
        new Date(now.getTime() - FAILED_UPLOAD_RETENTION_MS),
        new Date(now.getTime() - PENDING_UPLOAD_RETENTION_MS),
        staleBefore,
        perKindLimit,
      ),
    ]);
    const candidates = [...deleted, ...abandoned];
    const outcomes = await Promise.allSettled(
      candidates.map(async (file) => {
        await this.objects.delete(file);
        return file.id;
      }),
    );
    const purgedIds: string[] = [];
    const failedIds: string[] = [];
    for (const [index, outcome] of outcomes.entries()) {
      const file = candidates[index];
      if (!file) continue;
      if (outcome.status === "fulfilled") purgedIds.push(file.id);
      else failedIds.push(file.id);
    }

    await Promise.all([
      this.repository.complete(purgedIds, now),
      this.repository.release(failedIds, now),
    ]);

    return {
      claimed: candidates.length,
      purged: purgedIds.length,
      failed: failedIds.length,
    };
  }
}
