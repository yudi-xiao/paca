import { readFile } from "node:fs/promises";

import {
  type AgentHostConfig,
  AgentHostEnrollmentError,
  generateAgentHostIdentity,
  writePrivateJsonConfig,
} from "./host-enrollment";

type JsonRecord = Record<string, unknown>;

export type DelegatedAgentGrantRequest = {
  capability: string;
  constraints: JsonRecord;
};

export type DelegatedAgentConfig = {
  version: 1;
  providerOrigin: string;
  issuer: string;
  defaultLocation: string;
  hostId: string;
  agentId: string;
  agentName: string;
  keyAlgorithm: "Ed25519";
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
  capabilities: string[];
  grantRequests?: DelegatedAgentGrantRequest[];
  registeredAt: string;
};

export type DelegatedAgentRegistration = {
  config: DelegatedAgentConfig;
  approval: {
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    expiresIn: number | null;
  };
};

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function requireString(record: JsonRecord | null, field: string, code: string): string {
  const value = record?.[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new AgentHostEnrollmentError(code);
  }
  return value;
}

function base64url(value: string | ArrayBuffer): string {
  return Buffer.from(
    value instanceof ArrayBuffer ? new Uint8Array(value) : new TextEncoder().encode(value),
  ).toString("base64url");
}

async function signJwt(input: {
  privateKey: JsonWebKey;
  type: "host+jwt" | "agent+jwt";
  issuer: string;
  audience: string;
  subject?: string;
  capabilities?: string[];
  extra?: JsonRecord;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const header = base64url(JSON.stringify({ alg: "EdDSA", typ: input.type }));
  const payload = base64url(
    JSON.stringify({
      ...input.extra,
      ...(input.capabilities ? { capabilities: input.capabilities } : {}),
      iss: input.issuer,
      ...(input.subject ? { sub: input.subject } : {}),
      aud: input.audience,
      jti: crypto.randomUUID(),
      iat: now,
      exp: now + 45,
    }),
  );
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    input.privateKey,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64url(signature)}`;
}

async function jsonOrNull(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("application/json") ? response.json().catch(() => null) : null;
}

export async function readAgentHostConfig(path: string): Promise<AgentHostConfig> {
  const value = asRecord(JSON.parse(await readFile(path, "utf8")) as unknown);
  const privateKey = asRecord(value?.privateKey);
  if (
    value?.version !== 1 ||
    value?.keyAlgorithm !== "Ed25519" ||
    typeof value.hostId !== "string" ||
    typeof value.issuer !== "string" ||
    typeof value.defaultLocation !== "string" ||
    typeof privateKey?.d !== "string"
  ) {
    throw new AgentHostEnrollmentError("AGENT_HOST_CONFIG_INVALID");
  }
  return value as AgentHostConfig;
}

export async function registerDelegatedAgent(input: {
  hostConfig: AgentHostConfig;
  agentName: string;
  organizationId: string;
  projectId: string;
  taskId: string;
  fetch?: typeof fetch;
  now?: () => Date;
}): Promise<DelegatedAgentRegistration> {
  const request = input.fetch ?? fetch;
  const identity = await generateAgentHostIdentity();
  const validUntil = new Date(
    (input.now ?? (() => new Date()))().getTime() + 14 * 60_000,
  ).toISOString();
  const requestedCapabilities = [
    {
      name: "project.read",
      constraints: {
        organizationId: input.organizationId,
        projectId: input.projectId,
        validUntil,
      },
    },
    {
      name: "task.read",
      constraints: {
        organizationId: input.organizationId,
        projectId: input.projectId,
        taskId: input.taskId,
        validUntil,
      },
    },
    {
      name: "task.write",
      constraints: {
        organizationId: input.organizationId,
        projectId: input.projectId,
        taskId: input.taskId,
        field: "description",
        operationMode: "collaborate",
        validUntil,
      },
    },
    {
      name: "task.create",
      constraints: {
        organizationId: input.organizationId,
        projectId: input.projectId,
        operationMode: "collaborate",
        validUntil,
      },
    },
  ];
  const hostJwt = await signJwt({
    privateKey: input.hostConfig.privateKey,
    type: "host+jwt",
    issuer: input.hostConfig.hostId,
    audience: input.hostConfig.defaultLocation,
    extra: { agent_public_key: identity.publicKey as JsonRecord },
  });
  const response = await request(`${input.hostConfig.issuer}/agent/register`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${hostJwt}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: input.agentName,
      mode: "delegated",
      capabilities: requestedCapabilities,
      reason: "完善 DEMO-1 描述，并把当前开发待办拆分为 Demo Backlog 测试数据。",
      preferred_method: "device_authorization",
      binding_message: "仅限 Demo 项目的短时工作项读取、描述修改和 Backlog 创建测试。",
      force_approval: true,
    }),
    redirect: "error",
  });
  const body = asRecord(await jsonOrNull(response));
  if (!response.ok) {
    const remoteCode = body?.code ?? body?.error;
    throw new AgentHostEnrollmentError(
      typeof remoteCode === "string"
        ? `DELEGATED_AGENT_REGISTRATION_${remoteCode}`
        : `DELEGATED_AGENT_REGISTRATION_HTTP_${response.status}`,
    );
  }
  const approval = asRecord(body?.approval);
  const agentId = requireString(body, "agent_id", "DELEGATED_AGENT_RESPONSE_INVALID");
  if (body?.host_id !== input.hostConfig.hostId || body.status !== "pending") {
    throw new AgentHostEnrollmentError("DELEGATED_AGENT_RESPONSE_INVALID");
  }
  const userCode = requireString(approval, "user_code", "DELEGATED_AGENT_APPROVAL_INVALID");
  const verificationUri = requireString(
    approval,
    "verification_uri",
    "DELEGATED_AGENT_APPROVAL_INVALID",
  );
  const verificationUriComplete = requireString(
    approval,
    "verification_uri_complete",
    "DELEGATED_AGENT_APPROVAL_INVALID",
  );
  return {
    config: {
      version: 1,
      providerOrigin: input.hostConfig.providerOrigin,
      issuer: input.hostConfig.issuer,
      defaultLocation: input.hostConfig.defaultLocation,
      hostId: input.hostConfig.hostId,
      agentId,
      agentName: input.agentName,
      keyAlgorithm: "Ed25519",
      publicKey: identity.publicKey,
      privateKey: identity.privateKey,
      capabilities: requestedCapabilities.map(({ name }) => name),
      grantRequests: requestedCapabilities.map(({ name, constraints }) => ({
        capability: name,
        constraints,
      })),
      registeredAt: (input.now ?? (() => new Date()))().toISOString(),
    },
    approval: {
      userCode,
      verificationUri,
      verificationUriComplete,
      expiresIn: typeof approval?.expires_in === "number" ? approval.expires_in : null,
    },
  };
}

export async function writeDelegatedAgentConfig(
  path: string,
  config: DelegatedAgentConfig,
): Promise<void> {
  return writePrivateJsonConfig(path, config);
}

export async function requestAgentDeviceAuthorization(input: {
  hostConfig: AgentHostConfig;
  agentId: string;
  fetch?: typeof fetch;
}): Promise<DelegatedAgentRegistration["approval"]> {
  const hostJwt = await signJwt({
    privateKey: input.hostConfig.privateKey,
    type: "host+jwt",
    issuer: input.hostConfig.hostId,
    audience: input.hostConfig.defaultLocation,
  });
  const response = await (input.fetch ?? fetch)(`${input.hostConfig.issuer}/agent/device/code`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${hostJwt}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ agent_id: input.agentId }),
    redirect: "error",
  });
  const body = asRecord(await jsonOrNull(response));
  if (!response.ok) {
    const remoteCode = body?.code ?? body?.error;
    throw new AgentHostEnrollmentError(
      typeof remoteCode === "string"
        ? `AGENT_DEVICE_AUTHORIZATION_${remoteCode}`
        : `AGENT_DEVICE_AUTHORIZATION_HTTP_${response.status}`,
    );
  }
  return {
    userCode: requireString(body, "user_code", "AGENT_DEVICE_AUTHORIZATION_INVALID"),
    verificationUri: requireString(body, "verification_uri", "AGENT_DEVICE_AUTHORIZATION_INVALID"),
    verificationUriComplete: requireString(
      body,
      "verification_uri_complete",
      "AGENT_DEVICE_AUTHORIZATION_INVALID",
    ),
    expiresIn: typeof body?.expires_in === "number" ? body.expires_in : null,
  };
}

export async function executeAgentCapability(input: {
  config: DelegatedAgentConfig;
  capability: string;
  arguments: JsonRecord;
  fetch?: typeof fetch;
}): Promise<unknown> {
  if (!input.config.capabilities.includes(input.capability)) {
    throw new AgentHostEnrollmentError("AGENT_CAPABILITY_NOT_REQUESTED");
  }
  const jwt = await signJwt({
    privateKey: input.config.privateKey,
    type: "agent+jwt",
    issuer: input.config.hostId,
    subject: input.config.agentId,
    audience: input.config.defaultLocation,
    capabilities: input.config.capabilities,
  });
  const response = await (input.fetch ?? fetch)(input.config.defaultLocation, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ capability: input.capability, arguments: input.arguments }),
    redirect: "error",
  });
  const body = await jsonOrNull(response);
  if (!response.ok) {
    const record = asRecord(body);
    const remoteCode = record?.code ?? record?.error;
    throw new AgentHostEnrollmentError(
      typeof remoteCode === "string"
        ? `AGENT_EXECUTION_${remoteCode}`
        : `AGENT_EXECUTION_HTTP_${response.status}`,
    );
  }
  return body;
}

export async function getDelegatedAgentStatus(input: {
  config: DelegatedAgentConfig;
  fetch?: typeof fetch;
}): Promise<unknown> {
  const jwt = await signJwt({
    privateKey: input.config.privateKey,
    type: "agent+jwt",
    issuer: input.config.hostId,
    subject: input.config.agentId,
    audience: input.config.defaultLocation,
    capabilities: input.config.capabilities,
  });
  const url = new URL(`${input.config.issuer}/agent/status`);
  url.searchParams.set("agent_id", input.config.agentId);
  const response = await (input.fetch ?? fetch)(url, {
    headers: { accept: "application/json", authorization: `Bearer ${jwt}` },
    redirect: "error",
  });
  const body = await jsonOrNull(response);
  if (!response.ok) {
    const record = asRecord(body);
    const remoteCode = record?.code ?? record?.error;
    throw new AgentHostEnrollmentError(
      typeof remoteCode === "string"
        ? `AGENT_STATUS_${remoteCode}`
        : `AGENT_STATUS_HTTP_${response.status}`,
    );
  }
  return body;
}
