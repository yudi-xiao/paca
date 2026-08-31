import type { AppBindings } from "../bindings";
import { withDatabase } from "../database";
import type { AttachmentCleanupRepository } from "./cleanup";
import { AttachmentCleanupService } from "./cleanup";
import { PostgresAttachmentCleanupRepository } from "./postgres-cleanup-repository";
import { R2AttachmentObjectStore } from "./r2-store";

class RuntimeAttachmentCleanupRepository implements AttachmentCleanupRepository {
  constructor(private readonly env: AppBindings) {}

  claimDeleted(...args: Parameters<AttachmentCleanupRepository["claimDeleted"]>) {
    return this.withRepository((repository) => repository.claimDeleted(...args));
  }

  claimAbandoned(...args: Parameters<AttachmentCleanupRepository["claimAbandoned"]>) {
    return this.withRepository((repository) => repository.claimAbandoned(...args));
  }

  complete(...args: Parameters<AttachmentCleanupRepository["complete"]>) {
    return this.withRepository((repository) => repository.complete(...args));
  }

  release(...args: Parameters<AttachmentCleanupRepository["release"]>) {
    return this.withRepository((repository) => repository.release(...args));
  }

  private withRepository<T>(
    operation: (repository: PostgresAttachmentCleanupRepository) => Promise<T>,
  ): Promise<T> {
    return withDatabase(this.env, (database) =>
      operation(new PostgresAttachmentCleanupRepository(database)),
    );
  }
}

export function runAttachmentCleanup(env: AppBindings, now = new Date()) {
  const objects = new R2AttachmentObjectStore(env);
  return new AttachmentCleanupService(new RuntimeAttachmentCleanupRepository(env), {
    async delete(file) {
      if (file.uploadStatus !== "uploaded" && file.multipartUploadId) {
        await objects.abort(file).catch(() => undefined);
      }
      await objects.delete(file);
    },
  }).run(now);
}
