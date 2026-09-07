import { and, asc, eq, inArray, isNull, lt, or } from "drizzle-orm";

import type { PacaDatabase } from "../database";
import { pacaBrandingUploads, pacaWorkspaceSettings } from "../db/schema";
import {
  BrandingError,
  type BrandingRepository,
  type BrandingSettings,
  type BrandingSlot,
  type BrandingUpload,
  type BrandingUploadStatus,
  brandingErrorCodes,
} from "./service";

type UploadRow = typeof pacaBrandingUploads.$inferSelect;

function uploadFromRow(row: UploadRow): BrandingUpload {
  return {
    ...row,
    slot: row.slot as BrandingSlot,
    status: row.status as BrandingUploadStatus,
  };
}

export class PostgresBrandingRepository implements BrandingRepository {
  constructor(private readonly database: PacaDatabase) {}

  async get(): Promise<BrandingSettings> {
    const [settings] = await this.database
      .select()
      .from(pacaWorkspaceSettings)
      .where(eq(pacaWorkspaceSettings.id, true))
      .limit(1);
    if (!settings) throw new Error("BRANDING_SETTINGS_MISSING");

    const ids = [settings.logoUploadId, settings.faviconUploadId].filter(
      (id): id is string => id !== null,
    );
    const rows = ids.length
      ? await this.database
          .select()
          .from(pacaBrandingUploads)
          .where(inArray(pacaBrandingUploads.id, ids))
      : [];
    const byId = new Map(rows.map((row) => [row.id, uploadFromRow(row)]));
    return {
      logo: settings.logoUploadId ? (byId.get(settings.logoUploadId) ?? null) : null,
      favicon: settings.faviconUploadId ? (byId.get(settings.faviconUploadId) ?? null) : null,
      brandName: settings.brandName,
      primaryColorLight: settings.primaryColorLight,
      primaryColorDark: settings.primaryColorDark,
      updatedAt: settings.updatedAt,
      updatedBy: settings.updatedBy,
    };
  }

  async createPending(input: {
    id: string;
    slot: BrandingSlot;
    storageKey: string;
    fileName: string;
    contentType: string;
    declaredSize: number;
    uploadedBy: string;
  }): Promise<BrandingUpload> {
    const [created] = await this.database.insert(pacaBrandingUploads).values(input).returning();
    if (!created) throw new Error("BRANDING_UPLOAD_CREATE_FAILED");
    return uploadFromRow(created);
  }

  async findForUpload(id: string, uploadedBy: string): Promise<BrandingUpload> {
    const [row] = await this.database
      .select()
      .from(pacaBrandingUploads)
      .where(and(eq(pacaBrandingUploads.id, id), eq(pacaBrandingUploads.uploadedBy, uploadedBy)))
      .limit(1);
    if (!row) throw new BrandingError(brandingErrorCodes.uploadNotFound);
    return uploadFromRow(row);
  }

  async markUploaded(
    id: string,
    uploadedBy: string,
    inspection: { actualSize: number; etag: string },
  ): Promise<BrandingUpload> {
    const [updated] = await this.database
      .update(pacaBrandingUploads)
      .set({
        actualSize: inspection.actualSize,
        etag: inspection.etag,
        status: "uploaded",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(pacaBrandingUploads.id, id),
          eq(pacaBrandingUploads.uploadedBy, uploadedBy),
          eq(pacaBrandingUploads.status, "pending"),
        ),
      )
      .returning();
    if (!updated) throw new BrandingError(brandingErrorCodes.uploadNotPending);
    return uploadFromRow(updated);
  }

  async activate(id: string, uploadedBy: string, now: Date): Promise<BrandingSettings> {
    await this.database.transaction(async (transaction) => {
      const [settings] = await transaction
        .select()
        .from(pacaWorkspaceSettings)
        .where(eq(pacaWorkspaceSettings.id, true))
        .for("update")
        .limit(1);
      if (!settings) throw new Error("BRANDING_SETTINGS_MISSING");

      const [upload] = await transaction
        .select()
        .from(pacaBrandingUploads)
        .where(and(eq(pacaBrandingUploads.id, id), eq(pacaBrandingUploads.uploadedBy, uploadedBy)))
        .for("update")
        .limit(1);
      if (!upload) throw new BrandingError(brandingErrorCodes.uploadNotFound);
      if (upload.status !== "uploaded") {
        throw new BrandingError(brandingErrorCodes.uploadNotPending);
      }

      const previousId = upload.slot === "logo" ? settings.logoUploadId : settings.faviconUploadId;
      if (previousId && previousId !== upload.id) {
        await transaction
          .update(pacaBrandingUploads)
          .set({ status: "obsolete", updatedAt: now })
          .where(
            and(eq(pacaBrandingUploads.id, previousId), eq(pacaBrandingUploads.status, "active")),
          );
      }
      await transaction
        .update(pacaBrandingUploads)
        .set({ status: "active", cleanupClaimedAt: null, updatedAt: now })
        .where(eq(pacaBrandingUploads.id, upload.id));
      await transaction
        .update(pacaWorkspaceSettings)
        .set({
          ...(upload.slot === "logo"
            ? { logoUploadId: upload.id }
            : { faviconUploadId: upload.id }),
          updatedAt: now,
          updatedBy: uploadedBy,
        })
        .where(eq(pacaWorkspaceSettings.id, true));
    });
    return this.get();
  }

  async clear(slot: BrandingSlot, updatedBy: string, now: Date): Promise<BrandingSettings> {
    await this.database.transaction(async (transaction) => {
      const [settings] = await transaction
        .select()
        .from(pacaWorkspaceSettings)
        .where(eq(pacaWorkspaceSettings.id, true))
        .for("update")
        .limit(1);
      if (!settings) throw new Error("BRANDING_SETTINGS_MISSING");
      const previousId = slot === "logo" ? settings.logoUploadId : settings.faviconUploadId;
      if (previousId) {
        await transaction
          .update(pacaBrandingUploads)
          .set({ status: "obsolete", updatedAt: now })
          .where(
            and(eq(pacaBrandingUploads.id, previousId), eq(pacaBrandingUploads.status, "active")),
          );
      }
      await transaction
        .update(pacaWorkspaceSettings)
        .set({
          ...(slot === "logo" ? { logoUploadId: null } : { faviconUploadId: null }),
          updatedAt: now,
          updatedBy,
        })
        .where(eq(pacaWorkspaceSettings.id, true));
    });
    return this.get();
  }

  async update(
    input: {
      brandName: string | null;
      primaryColorLight: string | null;
      primaryColorDark: string | null;
    },
    updatedBy: string,
    now: Date,
  ): Promise<BrandingSettings> {
    await this.database
      .update(pacaWorkspaceSettings)
      .set({ ...input, updatedBy, updatedAt: now })
      .where(eq(pacaWorkspaceSettings.id, true));
    return this.get();
  }

  async findActiveImage(slot: BrandingSlot, fileId: string): Promise<BrandingUpload> {
    const settingsColumn =
      slot === "logo" ? pacaWorkspaceSettings.logoUploadId : pacaWorkspaceSettings.faviconUploadId;
    const [row] = await this.database
      .select({ upload: pacaBrandingUploads })
      .from(pacaWorkspaceSettings)
      .innerJoin(pacaBrandingUploads, eq(settingsColumn, pacaBrandingUploads.id))
      .where(
        and(
          eq(pacaWorkspaceSettings.id, true),
          eq(pacaBrandingUploads.id, fileId),
          eq(pacaBrandingUploads.slot, slot),
          eq(pacaBrandingUploads.status, "active"),
        ),
      )
      .limit(1);
    if (!row) throw new BrandingError(brandingErrorCodes.imageNotFound);
    return uploadFromRow(row.upload);
  }

  async claimCleanup(
    now: Date,
    abandonedBefore: Date,
    staleBefore: Date,
    limit: number,
  ): Promise<BrandingUpload[]> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select()
        .from(pacaBrandingUploads)
        .where(
          and(
            or(
              eq(pacaBrandingUploads.status, "obsolete"),
              and(
                inArray(pacaBrandingUploads.status, ["pending", "uploaded"]),
                lt(pacaBrandingUploads.createdAt, abandonedBefore),
              ),
            ),
            or(
              isNull(pacaBrandingUploads.cleanupClaimedAt),
              lt(pacaBrandingUploads.cleanupClaimedAt, staleBefore),
            ),
          ),
        )
        .orderBy(asc(pacaBrandingUploads.createdAt))
        .limit(limit)
        .for("update", { skipLocked: true });
      if (rows.length === 0) return [];
      const ids = rows.map((row) => row.id);
      const claimed = await transaction
        .update(pacaBrandingUploads)
        .set({ cleanupClaimedAt: now, updatedAt: now })
        .where(inArray(pacaBrandingUploads.id, ids))
        .returning();
      return claimed.map(uploadFromRow);
    });
  }

  async completeCleanup(ids: string[], claimedAt: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.database
      .delete(pacaBrandingUploads)
      .where(
        and(
          inArray(pacaBrandingUploads.id, ids),
          eq(pacaBrandingUploads.cleanupClaimedAt, claimedAt),
          inArray(pacaBrandingUploads.status, ["pending", "uploaded", "obsolete"]),
        ),
      );
  }

  async releaseCleanup(ids: string[], claimedAt: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.database
      .update(pacaBrandingUploads)
      .set({ cleanupClaimedAt: null })
      .where(
        and(
          inArray(pacaBrandingUploads.id, ids),
          eq(pacaBrandingUploads.cleanupClaimedAt, claimedAt),
          inArray(pacaBrandingUploads.status, ["pending", "uploaded", "obsolete"]),
        ),
      );
  }
}
