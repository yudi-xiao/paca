export {};

type JsonRecord = Record<string, unknown>;
type HeadersWithSetCookie = Headers & { getSetCookie?: () => string[] };

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_NOT_CONFIGURED`);
  return value;
}

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function data(value: unknown): JsonRecord {
  const envelope = record(value);
  const payload = record(envelope?.data);
  if (!payload) throw new Error("RESPONSE_DATA_INVALID");
  return payload;
}

function sessionCookie(response: Response): string {
  const headers = response.headers as HeadersWithSetCookie;
  const values = headers.getSetCookie?.() ?? [headers.get("set-cookie") ?? ""];
  for (const value of values) {
    const match = value.match(/(?:^|,\s*)([^=;,\s]*session_token)=([^;,\s]+)/i);
    if (match?.[1] && match[2]) return `${match[1]}=${match[2]}`;
  }
  throw new Error("SESSION_COOKIE_MISSING");
}

async function jsonRequest(
  baseUrl: string,
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  cookie?: string,
  body?: JsonRecord,
): Promise<Response> {
  const headers = new Headers({ origin: baseUrl });
  if (cookie) headers.set("cookie", cookie);
  if (body) headers.set("content-type", "application/json");
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
}

function requireStatus(response: Response, expected: number, step: string): void {
  if (response.status !== expected) throw new Error(`${step}_HTTP_${response.status}`);
}

const baseUrl = new URL(required("PACA_BRANDING_SMOKE_BASE_URL")).origin;
const email = required("PACA_BRANDING_SMOKE_EMAIL");
const password = required("PACA_BRANDING_SMOKE_PASSWORD");
const publicBefore = await jsonRequest(baseUrl, "/api/v1/branding", "GET");
requireStatus(publicBefore, 200, "PUBLIC_BEFORE");
const original = data(await publicBefore.json());
const slot = original.logo_url == null ? "logo" : original.favicon_url == null ? "favicon" : null;
if (!slot) throw new Error("BRANDING_SMOKE_REQUIRES_EMPTY_IMAGE_SLOT");

const signIn = await jsonRequest(baseUrl, "/api/auth/sign-in/email", "POST", undefined, {
  email,
  password,
  rememberMe: false,
});
requireStatus(signIn, 200, "SIGN_IN");
const cookie = sessionCookie(signIn);
let settingsChanged = false;
let imageActivated = false;

try {
  const marker = `Paca smoke ${crypto.randomUUID().slice(0, 8)}`;
  const update = await jsonRequest(baseUrl, "/api/v1/admin/settings", "PATCH", cookie, {
    brand_name: marker,
    primary_color_light: "#5a9e1c",
    primary_color_dark: "#9ed957",
  });
  requireStatus(update, 200, "UPDATE");
  if (data(await update.json()).brand_name !== marker) throw new Error("UPDATE_CONTRACT_INVALID");
  settingsChanged = true;

  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const basePath = `/api/v1/admin/settings/${slot}/avatar`;
  const initiate = await jsonRequest(baseUrl, `${basePath}/initiate-upload`, "POST", cookie, {
    file_name: "paca-smoke.png",
    content_type: "image/png",
    file_size: bytes.byteLength,
  });
  requireStatus(initiate, 201, "INITIATE");
  const session = data(await initiate.json());
  const fileId = typeof session.file_id === "string" ? session.file_id : null;
  const uploadUrl = typeof session.upload_url === "string" ? session.upload_url : null;
  if (!fileId || !uploadUrl) throw new Error("UPLOAD_SESSION_INVALID");

  const upload = await fetch(new URL(uploadUrl, baseUrl), {
    method: "PUT",
    headers: {
      cookie,
      origin: baseUrl,
      "content-type": "image/png",
      "content-length": String(bytes.byteLength),
    },
    body: bytes,
  });
  requireStatus(upload, 204, "UPLOAD");

  const complete = await jsonRequest(baseUrl, `${basePath}/complete-upload`, "POST", cookie, {
    file_id: fileId,
  });
  requireStatus(complete, 200, "COMPLETE");
  const completed = data(await complete.json());
  const imageUrl = typeof completed.avatar_url === "string" ? completed.avatar_url : null;
  if (!imageUrl?.endsWith(fileId)) throw new Error("COMPLETE_CONTRACT_INVALID");
  imageActivated = true;

  const image = await fetch(new URL(imageUrl, baseUrl));
  requireStatus(image, 200, "IMAGE");
  if (image.headers.get("content-type") !== "image/png") throw new Error("IMAGE_TYPE_INVALID");
  if (!(image.headers.get("cache-control") ?? "").includes("immutable")) {
    throw new Error("IMAGE_CACHE_INVALID");
  }
  const downloaded = new Uint8Array(await image.arrayBuffer());
  if (!bytes.every((byte, index) => downloaded[index] === byte)) {
    throw new Error("IMAGE_BODY_INVALID");
  }

  console.log(
    JSON.stringify({
      status: "ok",
      step: "branding-remote-smoke",
      publicRead: publicBefore.status,
      update: update.status,
      initiate: initiate.status,
      upload: upload.status,
      complete: complete.status,
      image: image.status,
      slot,
    }),
  );
} finally {
  if (imageActivated) {
    await jsonRequest(baseUrl, `/api/v1/admin/settings/${slot}/avatar`, "DELETE", cookie).catch(
      () => null,
    );
  }
  if (settingsChanged) {
    await jsonRequest(baseUrl, "/api/v1/admin/settings", "PATCH", cookie, {
      brand_name: typeof original.brand_name === "string" ? original.brand_name : null,
      primary_color_light:
        typeof original.primary_color_light === "string" ? original.primary_color_light : null,
      primary_color_dark:
        typeof original.primary_color_dark === "string" ? original.primary_color_dark : null,
    }).catch(() => null);
  }
  await jsonRequest(baseUrl, "/api/auth/sign-out", "POST", cookie, {}).catch(() => null);
}
