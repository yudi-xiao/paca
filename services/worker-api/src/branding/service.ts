export const brandingErrorCodes = {
  brandNameInvalid: "BRANDING_NAME_INVALID",
  colorInvalid: "BRANDING_COLOR_INVALID",
  contentTypeInvalid: "BRANDING_CONTENT_TYPE_INVALID",
  fileNameInvalid: "BRANDING_FILE_NAME_INVALID",
  imageInvalid: "BRANDING_IMAGE_INVALID",
  imageNotFound: "BRANDING_IMAGE_NOT_FOUND",
  sizeInvalid: "BRANDING_SIZE_INVALID",
  uploadNotFound: "BRANDING_UPLOAD_NOT_FOUND",
  uploadNotPending: "BRANDING_UPLOAD_NOT_PENDING",
  uploadSizeMismatch: "BRANDING_UPLOAD_SIZE_MISMATCH",
} as const;

export type BrandingErrorCode = (typeof brandingErrorCodes)[keyof typeof brandingErrorCodes];

export class BrandingError extends Error {
  constructor(
    readonly code: BrandingErrorCode,
    message = code,
  ) {
    super(message);
    this.name = "BrandingError";
  }
}

export type BrandingSlot = "logo" | "favicon";
export type BrandingUploadStatus = "pending" | "uploaded" | "active" | "obsolete";

export type BrandingUpload = {
  id: string;
  slot: BrandingSlot;
  storageKey: string;
  fileName: string;
  contentType: string;
  declaredSize: number;
  actualSize: number | null;
  etag: string | null;
  status: BrandingUploadStatus;
  uploadedBy: string | null;
  cleanupClaimedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type BrandingSettings = {
  logo: BrandingUpload | null;
  favicon: BrandingUpload | null;
  brandName: string | null;
  primaryColorLight: string | null;
  primaryColorDark: string | null;
  updatedAt: Date;
  updatedBy: string | null;
};

export type BrandingImageObject = {
  body: ReadableStream;
  contentType: string;
  etag: string;
  size: number;
};

export type BrandingRepository = {
  get(): Promise<BrandingSettings>;
  createPending(input: {
    id: string;
    slot: BrandingSlot;
    storageKey: string;
    fileName: string;
    contentType: string;
    declaredSize: number;
    uploadedBy: string;
  }): Promise<BrandingUpload>;
  findForUpload(id: string, uploadedBy: string): Promise<BrandingUpload>;
  markUploaded(
    id: string,
    uploadedBy: string,
    inspection: { actualSize: number; etag: string },
  ): Promise<BrandingUpload>;
  activate(id: string, uploadedBy: string, now: Date): Promise<BrandingSettings>;
  clear(slot: BrandingSlot, updatedBy: string, now: Date): Promise<BrandingSettings>;
  update(
    input: {
      brandName: string | null;
      primaryColorLight: string | null;
      primaryColorDark: string | null;
    },
    updatedBy: string,
    now: Date,
  ): Promise<BrandingSettings>;
  findActiveImage(slot: BrandingSlot, fileId: string): Promise<BrandingUpload>;
  claimCleanup(
    now: Date,
    abandonedBefore: Date,
    staleBefore: Date,
    limit: number,
  ): Promise<BrandingUpload[]>;
  completeCleanup(ids: string[], claimedAt: Date): Promise<void>;
  releaseCleanup(ids: string[], claimedAt: Date): Promise<void>;
};

export type BrandingObjectStore = {
  put(upload: BrandingUpload, body: ReadableStream): Promise<{ actualSize: number; etag: string }>;
  inspect(upload: BrandingUpload): Promise<{ bytes: Uint8Array; actualSize: number; etag: string }>;
  get(upload: BrandingUpload): Promise<BrandingImageObject>;
  delete(upload: BrandingUpload): Promise<void>;
};

export const BRANDING_MAX_IMAGE_SIZE = 5 * 1024 * 1024;
export const BRANDING_CLEANUP_BATCH_SIZE = 25;
export const BRANDING_ABANDONED_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const BRANDING_CLEANUP_CLAIM_STALE_MS = 15 * 60 * 1_000;

const brandingContentTypes = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);
const colorPattern = /^#[0-9a-f]{6}$/i;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function normalizeFileName(value: string): string {
  const basename = value.replaceAll("\\", "/").split("/").at(-1)?.trim() ?? "";
  const normalized = [...basename]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    })
    .join("");
  if (!normalized || normalized === "." || normalized === ".." || utf8Length(normalized) > 255) {
    throw new BrandingError(brandingErrorCodes.fileNameInvalid);
  }
  return normalized;
}

function normalizeContentType(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!brandingContentTypes.has(normalized)) {
    throw new BrandingError(brandingErrorCodes.contentTypeInvalid);
  }
  return normalized;
}

function normalizeBrandName(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  if (!normalized) return null;
  if (utf8Length(normalized) > 100) {
    throw new BrandingError(brandingErrorCodes.brandNameInvalid);
  }
  return normalized;
}

function normalizeColor(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!colorPattern.test(value)) throw new BrandingError(brandingErrorCodes.colorInvalid);
  return value.toLowerCase();
}

function storageSegment(value: string): string {
  return encodeURIComponent(value).replaceAll("%", "~").slice(0, 360);
}

function bytesEqual(actual: Uint8Array, expected: number[], offset = 0): boolean {
  return expected.every((value, index) => actual[offset + index] === value);
}

function hasValidSignature(contentType: string, bytes: Uint8Array): boolean {
  switch (contentType) {
    case "image/png":
      return bytesEqual(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return bytesEqual(bytes, [0xff, 0xd8, 0xff]);
    case "image/gif":
      return (
        new TextDecoder().decode(bytes.slice(0, 6)) === "GIF87a" ||
        new TextDecoder().decode(bytes.slice(0, 6)) === "GIF89a"
      );
    case "image/webp":
      return (
        bytesEqual(bytes, [0x52, 0x49, 0x46, 0x46]) &&
        bytesEqual(bytes, [0x57, 0x45, 0x42, 0x50], 8)
      );
    default:
      return false;
  }
}

export class BrandingService {
  constructor(
    private readonly repository: BrandingRepository,
    private readonly objects: BrandingObjectStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get(): Promise<BrandingSettings> {
    return this.repository.get();
  }

  async initiate(
    slot: BrandingSlot,
    uploadedBy: string,
    input: { fileName: string; contentType: string; fileSize: number },
    uploadBasePath: string,
  ): Promise<{ fileId: string; uploadUrl: string }> {
    const fileName = normalizeFileName(input.fileName);
    const contentType = normalizeContentType(input.contentType);
    if (
      !Number.isSafeInteger(input.fileSize) ||
      input.fileSize < 1 ||
      input.fileSize > BRANDING_MAX_IMAGE_SIZE
    ) {
      throw new BrandingError(brandingErrorCodes.sizeInvalid);
    }
    const id = crypto.randomUUID();
    await this.repository.createPending({
      id,
      slot,
      storageKey: ["branding", slot, id, storageSegment(fileName)].join("/"),
      fileName,
      contentType,
      declaredSize: input.fileSize,
      uploadedBy,
    });
    return { fileId: id, uploadUrl: `${uploadBasePath}/${id}` };
  }

  async upload(
    fileId: string,
    uploadedBy: string,
    contentLength: number | null,
    body: ReadableStream | null,
  ): Promise<{ etag: string }> {
    const upload = await this.repository.findForUpload(fileId, uploadedBy);
    if (upload.status !== "pending") {
      throw new BrandingError(brandingErrorCodes.uploadNotPending);
    }
    if (!body || contentLength !== upload.declaredSize) {
      throw new BrandingError(brandingErrorCodes.uploadSizeMismatch);
    }
    const stored = await this.objects.put(upload, body);
    if (stored.actualSize !== upload.declaredSize) {
      throw new BrandingError(brandingErrorCodes.uploadSizeMismatch);
    }
    await this.repository.markUploaded(fileId, uploadedBy, stored);
    return { etag: stored.etag };
  }

  async complete(fileId: string, uploadedBy: string): Promise<BrandingSettings> {
    const upload = await this.repository.findForUpload(fileId, uploadedBy);
    if (upload.status !== "uploaded") {
      throw new BrandingError(brandingErrorCodes.uploadNotPending);
    }
    const inspection = await this.objects.inspect(upload);
    if (
      inspection.actualSize !== upload.declaredSize ||
      inspection.etag !== upload.etag ||
      !hasValidSignature(upload.contentType, inspection.bytes)
    ) {
      throw new BrandingError(brandingErrorCodes.imageInvalid);
    }
    return this.repository.activate(fileId, uploadedBy, this.now());
  }

  remove(slot: BrandingSlot, updatedBy: string): Promise<BrandingSettings> {
    return this.repository.clear(slot, updatedBy, this.now());
  }

  update(
    input: {
      brandName?: string | null;
      primaryColorLight?: string | null;
      primaryColorDark?: string | null;
    },
    updatedBy: string,
  ): Promise<BrandingSettings> {
    return this.repository.update(
      {
        brandName: normalizeBrandName(input.brandName),
        primaryColorLight: normalizeColor(input.primaryColorLight),
        primaryColorDark: normalizeColor(input.primaryColorDark),
      },
      updatedBy,
      this.now(),
    );
  }

  async image(slot: BrandingSlot, fileId: string): Promise<BrandingImageObject> {
    return this.objects.get(await this.repository.findActiveImage(slot, fileId));
  }

  async cleanup(now = this.now()): Promise<{ claimed: number; purged: number; failed: number }> {
    const claimed = await this.repository.claimCleanup(
      now,
      new Date(now.getTime() - BRANDING_ABANDONED_RETENTION_MS),
      new Date(now.getTime() - BRANDING_CLEANUP_CLAIM_STALE_MS),
      BRANDING_CLEANUP_BATCH_SIZE,
    );
    const outcomes = await Promise.allSettled(
      claimed.map(async (upload) => {
        await this.objects.delete(upload);
        return upload.id;
      }),
    );
    const purgedIds: string[] = [];
    const failedIds: string[] = [];
    for (const [index, outcome] of outcomes.entries()) {
      const upload = claimed[index];
      if (!upload) continue;
      (outcome.status === "fulfilled" ? purgedIds : failedIds).push(upload.id);
    }
    await Promise.all([
      this.repository.completeCleanup(purgedIds, now),
      this.repository.releaseCleanup(failedIds, now),
    ]);
    return { claimed: claimed.length, purged: purgedIds.length, failed: failedIds.length };
  }
}
