export {};

type JsonRecord = Record<string, unknown>;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_NOT_CONFIGURED`);
  return value;
}

function internalBaseURL(): string {
  const configured = new URL(requiredEnvironment("PACA_INTERNAL_BASE_URL"));
  if (
    configured.protocol !== "https:" ||
    configured.username ||
    configured.password ||
    configured.pathname !== "/" ||
    configured.search ||
    configured.hash
  ) {
    throw new Error("PACA_INTERNAL_BASE_URL_INVALID");
  }
  return configured.origin;
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function requireStatus(response: Response, expected: number, step: string): void {
  if (response.status !== expected) throw new Error(`${step}_HTTP_${response.status}`);
}

function sessionCookie(response: Response): string {
  const value = response.headers.get("set-cookie") ?? "";
  const match = value.match(/([^=;,]*session_token)=[^;,]+/i);
  if (!match?.[0]) throw new Error("SESSION_COOKIE_MISSING");
  return match[0];
}

function requireData(value: unknown, step: string): JsonRecord {
  const data = asRecord(asRecord(value)?.data);
  if (!data) throw new Error(`${step}_DATA_INVALID`);
  return data;
}

function requireId(value: JsonRecord, step: string): string {
  const id = value.id;
  if (typeof id !== "string") throw new Error(`${step}_ID_INVALID`);
  return id;
}

function log(step: string, details: JsonRecord = {}): void {
  console.log(JSON.stringify({ status: "ok", step, ...details }));
}

async function request(
  baseURL: string,
  path: string,
  cookie: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  headers.set("origin", baseURL);
  return fetch(`${baseURL}${path}`, { ...init, headers, redirect: "manual" });
}

async function jsonRequest(
  baseURL: string,
  path: string,
  cookie: string,
  method: string,
  body: JsonRecord,
): Promise<Response> {
  return request(baseURL, path, cookie, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function main(): Promise<void> {
  const baseURL = internalBaseURL();
  const runId = process.env.PACA_ATTACHMENT_SMOKE_RUN_ID?.trim() || crypto.randomUUID();
  if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error("PACA_ATTACHMENT_SMOKE_RUN_ID_INVALID");
  const configuredEmail = process.env.PACA_ATTACHMENT_SMOKE_EMAIL?.trim();
  const email = configuredEmail || `attachment-smoke-${runId}@paca.test`;
  if (!email.includes("@")) throw new Error("PACA_ATTACHMENT_SMOKE_EMAIL_INVALID");
  const smokePassword = requiredEnvironment("PACA_ATTACHMENT_SMOKE_PASSWORD");
  if (smokePassword.length < 12) throw new Error("PACA_ATTACHMENT_SMOKE_PASSWORD_TOO_SHORT");
  const fileName = "r2-smoke.txt";
  const bytes = new TextEncoder().encode(`Paca R2 smoke ${runId}`);

  let cookie: string;
  if (configuredEmail) {
    const signIn = await fetch(`${baseURL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseURL },
      body: JSON.stringify({ email, password: smokePassword, rememberMe: false }),
      redirect: "manual",
    });
    requireStatus(signIn, 200, "SIGN_IN");
    cookie = sessionCookie(signIn);
  } else {
    const signUp = await fetch(`${baseURL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseURL },
      body: JSON.stringify({ email, name: "Paca Attachment Smoke", password: smokePassword }),
      redirect: "manual",
    });
    if (signUp.status === 200) {
      cookie = sessionCookie(signUp);
    } else {
      const signUpBody = asRecord(await signUp.json().catch(() => null));
      if (signUpBody?.code !== "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL") {
        throw new Error(`SIGN_UP_HTTP_${signUp.status}`);
      }
      const signIn = await fetch(`${baseURL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseURL },
        body: JSON.stringify({ email, password: smokePassword, rememberMe: false }),
        redirect: "manual",
      });
      requireStatus(signIn, 200, "SIGN_IN");
      cookie = sessionCookie(signIn);
    }
  }
  log("attachment-smoke-authenticated", { email });

  if (process.env.PACA_ATTACHMENT_SMOKE_SETUP_ONLY === "true") {
    log("attachment-smoke-setup-only", { email });
    return;
  }

  const createProject = await jsonRequest(baseURL, "/api/v1/projects", cookie, "POST", {
    name: `Attachment smoke ${runId.slice(0, 8)}`,
    task_id_prefix: "R2SMOKE",
  });
  requireStatus(createProject, 201, "CREATE_PROJECT");
  const projectId = requireId(requireData(await createProject.json(), "CREATE_PROJECT"), "PROJECT");

  const createTask = await jsonRequest(
    baseURL,
    `/api/v1/projects/${projectId}/tasks`,
    cookie,
    "POST",
    { title: "Attachment smoke task" },
  );
  requireStatus(createTask, 201, "CREATE_TASK");
  const taskId = requireId(requireData(await createTask.json(), "CREATE_TASK"), "TASK");

  if (process.env.PACA_ATTACHMENT_SMOKE_MULTIPART_CANCEL_ONLY === "true") {
    const multipartBytes = new Uint8Array(5 * 1024 * 1024);
    multipartBytes.fill(0x5a);
    const multipartInitiate = await jsonRequest(
      baseURL,
      `/api/v1/projects/${projectId}/tasks/${taskId}/attachments/initiate-upload`,
      cookie,
      "POST",
      {
        file_name: "r2-cancel-smoke.bin",
        content_type: "application/octet-stream",
        file_size: multipartBytes.byteLength,
      },
    );
    requireStatus(multipartInitiate, 201, "INITIATE_MULTIPART_UPLOAD");
    const multipartSession = requireData(
      await multipartInitiate.json(),
      "INITIATE_MULTIPART_UPLOAD",
    );
    const multipartFileId =
      typeof multipartSession.file_id === "string" ? multipartSession.file_id : null;
    const multipart = asRecord(multipartSession.multipart);
    const multipartUploadId = typeof multipart?.upload_id === "string" ? multipart.upload_id : null;
    const parts = Array.isArray(multipart?.parts) ? multipart.parts : [];
    const firstPart = asRecord(parts[0]);
    const partURL = typeof firstPart?.upload_url === "string" ? firstPart.upload_url : null;
    if (
      !multipartFileId ||
      multipartSession.is_multipart !== true ||
      !multipartUploadId ||
      parts.length !== 1 ||
      firstPart?.part_number !== 1 ||
      !partURL
    ) {
      throw new Error("INITIATE_MULTIPART_UPLOAD_DATA_INVALID");
    }

    const uploadPart = await request(baseURL, partURL, cookie, {
      method: "PUT",
      headers: {
        "content-length": String(multipartBytes.byteLength),
        "content-type": "application/octet-stream",
      },
      body: multipartBytes,
    });
    requireStatus(uploadPart, 204, "UPLOAD_MULTIPART_PART");
    const partEtag = uploadPart.headers.get("etag");
    if (!partEtag) throw new Error("UPLOAD_MULTIPART_PART_ETAG_MISSING");

    const cancel = await request(
      baseURL,
      `/api/v1/projects/${projectId}/tasks/${taskId}/attachments/uploads/${multipartFileId}`,
      cookie,
      { method: "DELETE" },
    );
    requireStatus(cancel, 204, "CANCEL_MULTIPART_UPLOAD");

    const completeAfterCancel = await jsonRequest(
      baseURL,
      `/api/v1/projects/${projectId}/tasks/${taskId}/attachments/complete-upload`,
      cookie,
      "POST",
      {
        file_id: multipartFileId,
        upload_id: multipartUploadId,
        parts: [{ part_number: 1, etag: partEtag }],
      },
    );
    requireStatus(completeAfterCancel, 404, "COMPLETE_AFTER_MULTIPART_CANCEL");

    const listAfterCancel = await request(
      baseURL,
      `/api/v1/projects/${projectId}/tasks/${taskId}/attachments`,
      cookie,
    );
    requireStatus(listAfterCancel, 200, "LIST_AFTER_MULTIPART_CANCEL");
    const itemsAfterCancel = requireData(
      await listAfterCancel.json(),
      "LIST_AFTER_MULTIPART_CANCEL",
    ).items;
    if (!Array.isArray(itemsAfterCancel) || itemsAfterCancel.length !== 0) {
      throw new Error("MULTIPART_CANCEL_CREATED_ATTACHMENT");
    }

    const signOut = await jsonRequest(baseURL, "/api/auth/sign-out", cookie, "POST", {});
    requireStatus(signOut, 200, "SIGN_OUT");
    log("attachment-multipart-cancel-smoke-complete", {
      email,
      projectId,
      taskId,
      fileId: multipartFileId,
    });
    return;
  }

  if (process.env.PACA_ATTACHMENT_SMOKE_PERMISSION_REVOKE_ONLY === "true") {
    const memberEmail = `attachment-revoke-${runId}@paca.test`;
    const memberPassword = `${crypto.randomUUID()}-Aa1!`;
    const memberSignUp = await fetch(`${baseURL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseURL },
      body: JSON.stringify({
        email: memberEmail,
        name: "Paca Attachment Revocation Smoke",
        password: memberPassword,
      }),
      redirect: "manual",
    });
    requireStatus(memberSignUp, 200, "MEMBER_SIGN_UP");
    const memberCookie = sessionCookie(memberSignUp);
    const memberSession = await request(baseURL, "/api/auth/get-session", memberCookie);
    requireStatus(memberSession, 200, "MEMBER_GET_SESSION");
    const memberUser = asRecord(asRecord(await memberSession.json())?.user);
    const memberUserId = typeof memberUser?.id === "string" ? memberUser.id : null;
    if (!memberUserId) throw new Error("MEMBER_USER_ID_INVALID");

    const rolesResponse = await request(baseURL, `/api/v1/projects/${projectId}/roles`, cookie);
    requireStatus(rolesResponse, 200, "LIST_PROJECT_ROLES");
    const rolesBody = asRecord(await rolesResponse.json());
    const roles = Array.isArray(rolesBody?.data) ? rolesBody.data : [];
    const editorRole = roles
      .map(asRecord)
      .find((role) => typeof role?.role_name === "string" && role.role_name === "Editor");
    const editorRoleId = typeof editorRole?.id === "string" ? editorRole.id : null;
    if (!editorRoleId) throw new Error("EDITOR_ROLE_MISSING");

    const addMember = await jsonRequest(
      baseURL,
      `/api/v1/projects/${projectId}/members`,
      cookie,
      "POST",
      { user_id: memberUserId, project_role_id: editorRoleId },
    );
    requireStatus(addMember, 201, "ADD_PROJECT_MEMBER");
    const member = requireData(await addMember.json(), "ADD_PROJECT_MEMBER");
    const projectMemberId = requireId(member, "PROJECT_MEMBER");

    const initiateAsMember = await jsonRequest(
      baseURL,
      `/api/v1/projects/${projectId}/tasks/${taskId}/attachments/initiate-upload`,
      memberCookie,
      "POST",
      {
        file_name: "r2-revocation-smoke.bin",
        content_type: "application/octet-stream",
        file_size: 5 * 1024 * 1024,
      },
    );
    requireStatus(initiateAsMember, 201, "MEMBER_INITIATE_MULTIPART_UPLOAD");
    const upload = requireData(await initiateAsMember.json(), "MEMBER_INITIATE_MULTIPART_UPLOAD");
    const fileId = typeof upload.file_id === "string" ? upload.file_id : null;
    const uploadParts = Array.isArray(asRecord(upload.multipart)?.parts)
      ? (asRecord(upload.multipart)?.parts as unknown[])
      : [];
    const firstPart = asRecord(uploadParts[0]);
    const partURL = typeof firstPart?.upload_url === "string" ? firstPart.upload_url : null;
    if (!fileId || upload.is_multipart !== true || uploadParts.length !== 1 || !partURL) {
      throw new Error("MEMBER_INITIATE_MULTIPART_UPLOAD_DATA_INVALID");
    }

    const removeMember = await request(
      baseURL,
      `/api/v1/projects/${projectId}/members/${projectMemberId}`,
      cookie,
      { method: "DELETE" },
    );
    requireStatus(removeMember, 200, "REMOVE_PROJECT_MEMBER");

    const deniedPart = await request(baseURL, partURL, memberCookie, {
      method: "PUT",
      headers: { "content-length": "1", "content-type": "application/octet-stream" },
      body: new Uint8Array([0x5a]),
    });
    requireStatus(deniedPart, 403, "UPLOAD_PART_AFTER_PERMISSION_REVOKE");
    const deniedCancel = await request(
      baseURL,
      `/api/v1/projects/${projectId}/tasks/${taskId}/attachments/uploads/${fileId}`,
      memberCookie,
      { method: "DELETE" },
    );
    requireStatus(deniedCancel, 403, "CANCEL_AFTER_PERMISSION_REVOKE");

    const restoreMember = await jsonRequest(
      baseURL,
      `/api/v1/projects/${projectId}/members`,
      cookie,
      "POST",
      { user_id: memberUserId, project_role_id: editorRoleId },
    );
    requireStatus(restoreMember, 201, "RESTORE_PROJECT_MEMBER");
    const restoredMemberId = requireId(
      requireData(await restoreMember.json(), "RESTORE_PROJECT_MEMBER"),
      "RESTORED_PROJECT_MEMBER",
    );
    const cancelAfterRestore = await request(
      baseURL,
      `/api/v1/projects/${projectId}/tasks/${taskId}/attachments/uploads/${fileId}`,
      memberCookie,
      { method: "DELETE" },
    );
    requireStatus(cancelAfterRestore, 204, "CANCEL_AFTER_PERMISSION_RESTORE");

    const removeRestoredMember = await request(
      baseURL,
      `/api/v1/projects/${projectId}/members/${restoredMemberId}`,
      cookie,
      { method: "DELETE" },
    );
    requireStatus(removeRestoredMember, 200, "REMOVE_RESTORED_PROJECT_MEMBER");
    const deniedInitiate = await jsonRequest(
      baseURL,
      `/api/v1/projects/${projectId}/tasks/${taskId}/attachments/initiate-upload`,
      memberCookie,
      "POST",
      {
        file_name: "r2-revocation-retry.bin",
        content_type: "application/octet-stream",
        file_size: 1,
      },
    );
    requireStatus(deniedInitiate, 403, "INITIATE_AFTER_PERMISSION_REVOKE");

    const memberSignOut = await jsonRequest(
      baseURL,
      "/api/auth/sign-out",
      memberCookie,
      "POST",
      {},
    );
    requireStatus(memberSignOut, 200, "MEMBER_SIGN_OUT");
    const adminSignOut = await jsonRequest(baseURL, "/api/auth/sign-out", cookie, "POST", {});
    requireStatus(adminSignOut, 200, "SIGN_OUT");
    log("attachment-permission-revocation-smoke-complete", {
      projectId,
      taskId,
      fileId,
      memberUserId,
      memberEmail,
    });
    return;
  }

  const initiate = await jsonRequest(
    baseURL,
    `/api/v1/projects/${projectId}/tasks/${taskId}/attachments/initiate-upload`,
    cookie,
    "POST",
    { file_name: fileName, content_type: "text/plain", file_size: bytes.byteLength },
  );
  requireStatus(initiate, 201, "INITIATE_UPLOAD");
  const upload = requireData(await initiate.json(), "INITIATE_UPLOAD");
  const fileId = typeof upload.file_id === "string" ? upload.file_id : null;
  const uploadURL = typeof upload.upload_url === "string" ? upload.upload_url : null;
  if (!fileId || !uploadURL || upload.is_multipart !== false) {
    throw new Error("INITIATE_UPLOAD_DATA_INVALID");
  }

  const objectKey = `organizations/paca-default/projects/${projectId}/tasks/${taskId}/attachments/${fileId}/${fileName}`;
  log("attachment-smoke-resources-created", { email, projectId, taskId, fileId, objectKey });

  const uploadResponse = await request(baseURL, uploadURL, cookie, {
    method: "PUT",
    headers: {
      "content-length": String(bytes.byteLength),
      "content-type": "text/plain",
    },
    body: bytes,
  });
  requireStatus(uploadResponse, 204, "UPLOAD_OBJECT");
  if (!uploadResponse.headers.get("etag")) throw new Error("UPLOAD_ETAG_MISSING");

  const complete = await jsonRequest(
    baseURL,
    `/api/v1/projects/${projectId}/tasks/${taskId}/attachments/complete-upload`,
    cookie,
    "POST",
    { file_id: fileId, parts: [] },
  );
  requireStatus(complete, 201, "COMPLETE_UPLOAD");
  const attachment = requireData(await complete.json(), "COMPLETE_UPLOAD");
  const attachmentId = requireId(attachment, "ATTACHMENT");
  const file = asRecord(attachment.file);
  if (
    file?.file_name !== fileName ||
    file.file_size !== bytes.byteLength ||
    typeof file.sha256 !== "string" ||
    file.sha256.length !== 64
  ) {
    throw new Error("COMPLETE_UPLOAD_METADATA_INVALID");
  }

  const list = await request(
    baseURL,
    `/api/v1/projects/${projectId}/tasks/${taskId}/attachments`,
    cookie,
  );
  requireStatus(list, 200, "LIST_ATTACHMENTS");
  const items = requireData(await list.json(), "LIST_ATTACHMENTS").items;
  if (!Array.isArray(items) || items.length !== 1 || asRecord(items[0])?.id !== attachmentId) {
    throw new Error("LIST_ATTACHMENTS_INVALID");
  }

  const content = await request(
    baseURL,
    `/api/v1/projects/${projectId}/tasks/${taskId}/attachments/${attachmentId}/content`,
    cookie,
    { headers: { range: "bytes=0-3" } },
  );
  requireStatus(content, 206, "DOWNLOAD_RANGE");
  if (
    content.headers.get("x-content-type-options") !== "nosniff" ||
    content.headers.get("cache-control") !== "private, no-store" ||
    (await content.text()) !== new TextDecoder().decode(bytes.slice(0, 4))
  ) {
    throw new Error("DOWNLOAD_RANGE_INVALID");
  }

  const remove = await request(
    baseURL,
    `/api/v1/projects/${projectId}/tasks/${taskId}/attachments/${attachmentId}`,
    cookie,
    { method: "DELETE" },
  );
  requireStatus(remove, 204, "DELETE_ATTACHMENT");

  const emptyList = await request(
    baseURL,
    `/api/v1/projects/${projectId}/tasks/${taskId}/attachments`,
    cookie,
  );
  requireStatus(emptyList, 200, "LIST_AFTER_DELETE");
  const remaining = requireData(await emptyList.json(), "LIST_AFTER_DELETE").items;
  if (!Array.isArray(remaining) || remaining.length !== 0) {
    throw new Error("DELETE_ATTACHMENT_NOT_HIDDEN");
  }

  const deletedList = await request(
    baseURL,
    `/api/v1/projects/${projectId}/tasks/${taskId}/attachments?deleted=true`,
    cookie,
  );
  requireStatus(deletedList, 200, "LIST_DELETED_ATTACHMENTS");
  const deletedItems = requireData(await deletedList.json(), "LIST_DELETED_ATTACHMENTS").items;
  const deletedItemList = Array.isArray(deletedItems) ? deletedItems : [];
  const deletedAttachment = asRecord(deletedItemList[0]);
  if (
    deletedItemList.length !== 1 ||
    deletedAttachment?.id !== attachmentId ||
    typeof deletedAttachment.deleted_at !== "string" ||
    typeof deletedAttachment.purge_after !== "string"
  ) {
    throw new Error("LIST_DELETED_ATTACHMENTS_INVALID");
  }

  const restore = await request(
    baseURL,
    `/api/v1/projects/${projectId}/tasks/${taskId}/attachments/${attachmentId}/restore`,
    cookie,
    { method: "POST" },
  );
  requireStatus(restore, 200, "RESTORE_ATTACHMENT");
  const restored = requireData(await restore.json(), "RESTORE_ATTACHMENT");
  if (
    restored.id !== attachmentId ||
    restored.deleted_at !== null ||
    restored.purge_after !== null
  ) {
    throw new Error("RESTORE_ATTACHMENT_INVALID");
  }

  const restoredList = await request(
    baseURL,
    `/api/v1/projects/${projectId}/tasks/${taskId}/attachments`,
    cookie,
  );
  requireStatus(restoredList, 200, "LIST_AFTER_RESTORE");
  const restoredItems = requireData(await restoredList.json(), "LIST_AFTER_RESTORE").items;
  if (
    !Array.isArray(restoredItems) ||
    restoredItems.length !== 1 ||
    asRecord(restoredItems[0])?.id !== attachmentId
  ) {
    throw new Error("RESTORE_ATTACHMENT_NOT_VISIBLE");
  }

  const finalRemove = await request(
    baseURL,
    `/api/v1/projects/${projectId}/tasks/${taskId}/attachments/${attachmentId}`,
    cookie,
    { method: "DELETE" },
  );
  requireStatus(finalRemove, 204, "DELETE_RESTORED_ATTACHMENT");

  const signOut = await jsonRequest(baseURL, "/api/auth/sign-out", cookie, "POST", {});
  requireStatus(signOut, 200, "SIGN_OUT");

  log("attachment-smoke-complete", { email, projectId, taskId, fileId, attachmentId, objectKey });
}

try {
  await main();
} catch (error: unknown) {
  const code = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  console.error(JSON.stringify({ status: "error", step: "attachment-smoke", code }));
  process.exitCode = 1;
}

process.exit(process.exitCode ?? 0);
