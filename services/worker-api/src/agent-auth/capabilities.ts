import type {
  AgentSession,
  Capability,
  CapabilityConstraints,
  ConstraintOperators,
  ConstraintPrimitive,
} from "@better-auth/agent-auth";
import * as z from "zod";

export const PACA_AGENT_GRANT_TTL_SECONDS = 15 * 60;
const MAX_CONSTRAINT_LIST_SIZE = 100;

export const pacaCapabilityNames = [
  "project.read",
  "task.read",
  "task.write",
  "task.create",
  "document.read",
  "document.edit",
  "environment.connect",
  "workflow.execute",
] as const;

export type PacaCapabilityName = (typeof pacaCapabilityNames)[number];

const scopeProperties = {
  organizationId: { type: "string", minLength: 1, maxLength: 255 },
  projectId: { type: "string", format: "uuid" },
  validUntil: { type: "string", format: "date-time" },
} as const;

const scopedInput = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  additionalProperties: false,
  properties: { ...scopeProperties, ...properties },
  required: ["organizationId", "projectId", "validUntil", ...required],
});

export const pacaCapabilities = [
  {
    name: "project.read",
    description: "读取一个明确 Organization 下的 Paca 项目。",
    approvalStrength: "session",
    requiredConstraints: ["organizationId", "projectId", "validUntil"],
    grantTTL: PACA_AGENT_GRANT_TTL_SECONDS,
    input: scopedInput({}, []),
  },
  {
    name: "task.read",
    description: "读取一个或一组明确限定的 Paca 任务。",
    approvalStrength: "session",
    requiredConstraints: ["organizationId", "projectId", "taskId", "validUntil"],
    grantTTL: PACA_AGENT_GRANT_TTL_SECONDS,
    input: scopedInput({ taskId: { type: "string", format: "uuid" } }, ["taskId"]),
  },
  {
    name: "task.write",
    description: "在明确任务、字段和操作模式范围内修改 Paca 任务。",
    approvalStrength: "session",
    requiredConstraints: [
      "organizationId",
      "projectId",
      "taskId",
      "field",
      "operationMode",
      "validUntil",
    ],
    grantTTL: PACA_AGENT_GRANT_TTL_SECONDS,
    input: scopedInput(
      {
        taskId: { type: "string", format: "uuid" },
        field: { type: "string", minLength: 1, maxLength: 100 },
        operationMode: { type: "string", enum: ["suggest", "collaborate"] },
        value: {},
      },
      ["taskId", "field", "operationMode", "value"],
    ),
  },
  {
    name: "task.create",
    description: "在明确 Organization 和 Project 范围内创建 Paca Backlog 工作项。",
    approvalStrength: "session",
    requiredConstraints: ["organizationId", "projectId", "operationMode", "validUntil"],
    grantTTL: PACA_AGENT_GRANT_TTL_SECONDS,
    input: scopedInput(
      {
        operationMode: { type: "string", enum: ["suggest", "collaborate"] },
        title: { type: "string", minLength: 1, maxLength: 500 },
        description: { type: "array" },
        importance: { type: "number", minimum: 0, maximum: 1_000_000 },
        storyPoints: { type: ["number", "null"], minimum: 0, maximum: 1_000_000 },
        tags: {
          type: "array",
          maxItems: 50,
          items: { type: "string", maxLength: 100 },
        },
      },
      ["operationMode", "title"],
    ),
  },
  {
    name: "document.read",
    description: "读取一个明确限定的 Paca 文档。",
    approvalStrength: "session",
    requiredConstraints: ["organizationId", "projectId", "documentId", "validUntil"],
    grantTTL: PACA_AGENT_GRANT_TTL_SECONDS,
    input: scopedInput({ documentId: { type: "string", format: "uuid" } }, ["documentId"]),
  },
  {
    name: "document.edit",
    description: "在明确文档、字段和操作模式范围内编辑 Paca 文档。",
    approvalStrength: "session",
    requiredConstraints: [
      "organizationId",
      "projectId",
      "documentId",
      "field",
      "operationMode",
      "validUntil",
    ],
    grantTTL: PACA_AGENT_GRANT_TTL_SECONDS,
    input: scopedInput(
      {
        documentId: { type: "string", format: "uuid" },
        field: { type: "string", minLength: 1, maxLength: 100 },
        operationMode: { type: "string", enum: ["suggest", "collaborate", "exclusive"] },
      },
      ["documentId", "field", "operationMode"],
    ),
  },
  {
    name: "environment.connect",
    description: "连接一个明确限定的 Paca 执行环境。",
    approvalStrength: "session",
    requiredConstraints: [
      "organizationId",
      "projectId",
      "environmentId",
      "operationMode",
      "validUntil",
    ],
    grantTTL: PACA_AGENT_GRANT_TTL_SECONDS,
    input: scopedInput(
      {
        environmentId: { type: "string", format: "uuid" },
        operationMode: { type: "string", enum: ["read", "execute"] },
      },
      ["environmentId", "operationMode"],
    ),
  },
  {
    name: "workflow.execute",
    description: "执行一个明确限定的 Paca Workflow。",
    approvalStrength: "session",
    requiredConstraints: [
      "organizationId",
      "projectId",
      "workflowId",
      "operationMode",
      "validUntil",
    ],
    grantTTL: PACA_AGENT_GRANT_TTL_SECONDS,
    input: scopedInput(
      {
        workflowId: { type: "string", format: "uuid" },
        operationMode: { type: "string", enum: ["execute"] },
      },
      ["workflowId", "operationMode"],
    ),
  },
] satisfies Capability[];

const capabilityNameSet = new Set<string>(pacaCapabilityNames);

export function areKnownPacaCapabilities(capabilities: string[]): boolean {
  return capabilities.every((capability) => capabilityNameSet.has(capability));
}

export type AgentConstraintContext = {
  organizationId?: string;
  projectId?: string;
  taskId?: string;
  documentId?: string;
  environmentId?: string;
  workflowId?: string;
  field?: string;
  operationMode?: string;
};

export type AgentCapabilityDecision =
  | { allowed: true }
  | {
      allowed: false;
      code:
        | "AGENT_CAPABILITY_NOT_GRANTED"
        | "AGENT_GRANT_CONSTRAINTS_INVALID"
        | "AGENT_GRANT_CONSTRAINT_MISMATCH"
        | "AGENT_GRANT_EXPIRED";
    };

const primitiveSchema = z.union([z.string(), z.number(), z.boolean()]);
const operatorSchema = z
  .object({
    eq: primitiveSchema.optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    in: z.array(primitiveSchema).min(1).max(MAX_CONSTRAINT_LIST_SIZE).optional(),
    not_in: z.array(primitiveSchema).min(1).max(MAX_CONSTRAINT_LIST_SIZE).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
const constraintValueSchema = z.union([primitiveSchema, operatorSchema]);

const requiredConstraints = {
  "project.read": ["organizationId", "projectId", "validUntil"],
  "task.read": ["organizationId", "projectId", "taskId", "validUntil"],
  "task.write": ["organizationId", "projectId", "taskId", "field", "operationMode", "validUntil"],
  "task.create": ["organizationId", "projectId", "operationMode", "validUntil"],
  "document.read": ["organizationId", "projectId", "documentId", "validUntil"],
  "document.edit": [
    "organizationId",
    "projectId",
    "documentId",
    "field",
    "operationMode",
    "validUntil",
  ],
  "environment.connect": [
    "organizationId",
    "projectId",
    "environmentId",
    "operationMode",
    "validUntil",
  ],
  "workflow.execute": ["organizationId", "projectId", "workflowId", "operationMode", "validUntil"],
} as const satisfies Record<PacaCapabilityName, readonly string[]>;

export function exactConstraintString(value: unknown): string | null {
  if (typeof value === "string") return value;
  const parsed = operatorSchema.safeParse(value);
  return parsed.success && typeof parsed.data.eq === "string" ? parsed.data.eq : null;
}

function matchesConstraint(constraint: ConstraintPrimitive | ConstraintOperators, value: string) {
  if (typeof constraint !== "object") return constraint === value;
  if (constraint.eq !== undefined && constraint.eq !== value) return false;
  if (constraint.in && !constraint.in.includes(value)) return false;
  if (constraint.not_in?.includes(value)) return false;
  // String-scoped identifiers and modes never accept numeric range operators.
  if (constraint.min !== undefined || constraint.max !== undefined) return false;
  return true;
}

export function evaluateAgentCapability(
  session: AgentSession,
  capability: PacaCapabilityName,
  context: AgentConstraintContext,
  now = new Date(),
): AgentCapabilityDecision {
  const grant = session.agent.capabilityGrants.find(
    (candidate) => candidate.capability === capability && candidate.status === "active",
  );
  if (!grant) return { allowed: false, code: "AGENT_CAPABILITY_NOT_GRANTED" };

  const constraints = grant.constraints;
  if (!constraints) return { allowed: false, code: "AGENT_GRANT_CONSTRAINTS_INVALID" };

  const parsed = z.record(z.string(), constraintValueSchema).safeParse(constraints);
  if (!parsed.success) return { allowed: false, code: "AGENT_GRANT_CONSTRAINTS_INVALID" };

  const required = requiredConstraints[capability];
  if (required.some((field) => !(field in parsed.data))) {
    return { allowed: false, code: "AGENT_GRANT_CONSTRAINTS_INVALID" };
  }

  const validUntil = exactConstraintString(parsed.data.validUntil);
  if (!validUntil) return { allowed: false, code: "AGENT_GRANT_CONSTRAINTS_INVALID" };
  const expiry = Date.parse(validUntil);
  if (!Number.isFinite(expiry)) {
    return { allowed: false, code: "AGENT_GRANT_CONSTRAINTS_INVALID" };
  }
  if (expiry <= now.getTime()) return { allowed: false, code: "AGENT_GRANT_EXPIRED" };

  for (const [field, value] of Object.entries(context)) {
    if (value === undefined) continue;
    const constraint = parsed.data[field];
    if (!constraint || !matchesConstraint(constraint, value)) {
      return { allowed: false, code: "AGENT_GRANT_CONSTRAINT_MISMATCH" };
    }
  }

  return { allowed: true };
}

export function hasValidCapabilityConstraints(
  capability: PacaCapabilityName,
  constraints: CapabilityConstraints | null,
): boolean {
  if (!constraints) return false;
  const parsed = z.record(z.string(), constraintValueSchema).safeParse(constraints);
  if (!parsed.success) return false;
  return requiredConstraints[capability].every((field) => field in parsed.data);
}
