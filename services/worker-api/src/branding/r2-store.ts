import type { AppBindings } from "../bindings";
import {
  BrandingError,
  type BrandingImageObject,
  type BrandingObjectStore,
  type BrandingUpload,
  brandingErrorCodes,
} from "./service";

export class R2BrandingObjectStore implements BrandingObjectStore {
  constructor(private readonly env: AppBindings) {}

  async put(
    upload: BrandingUpload,
    body: ReadableStream,
  ): Promise<{ actualSize: number; etag: string }> {
    const object = await this.env.TASK_ATTACHMENTS.put(upload.storageKey, body, {
      onlyIf: new Headers({ "if-none-match": "*" }),
      httpMetadata: { contentType: upload.contentType },
      customMetadata: { brandingSlot: upload.slot, brandingUploadId: upload.id },
    });
    if (!object) throw new BrandingError(brandingErrorCodes.uploadNotPending);
    return { actualSize: object.size, etag: object.etag };
  }

  async inspect(
    upload: BrandingUpload,
  ): Promise<{ bytes: Uint8Array; actualSize: number; etag: string }> {
    const object = await this.env.TASK_ATTACHMENTS.get(upload.storageKey, {
      range: { offset: 0, length: 16 },
    });
    if (!object) throw new BrandingError(brandingErrorCodes.imageNotFound);
    return {
      bytes: new Uint8Array(await new Response(object.body).arrayBuffer()),
      actualSize: object.size,
      etag: object.etag,
    };
  }

  async get(upload: BrandingUpload): Promise<BrandingImageObject> {
    const object = await this.env.TASK_ATTACHMENTS.get(upload.storageKey);
    if (!object) throw new BrandingError(brandingErrorCodes.imageNotFound);
    return {
      body: object.body,
      contentType: upload.contentType,
      etag: object.httpEtag,
      size: object.size,
    };
  }

  async delete(upload: BrandingUpload): Promise<void> {
    await this.env.TASK_ATTACHMENTS.delete(upload.storageKey);
  }
}
