import { Agent } from "agents";
import * as z from "zod";
import {
  type HostedTaskLeaseMirror,
  hostedTaskLeaseMirrorSchema,
} from "../agent-task/cloudflare-adapter";
import {
  type AgentRunCreate,
  type AgentRunRecord,
  type AgentRunStatus,
  type AgentRunTransition,
  agentRunCreateFingerprint,
  agentRunCreateSchema,
  agentRunTransitionSchema,
  canTransitionAgentRun,
  isTerminalAgentRunStatus,
} from "./protocol";

type RunRow = {
  runId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  agentId: string;
  workflowId: string;
  organizationId: string;
  projectId: string;
  documentId: string | null;
  kind: "document.edit";
  status: AgentRunStatus;
  version: number;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  errorCode: string | null;
};

type TransitionRow = {
  transitionId: string;
  runId: string;
  toStatus: AgentRunStatus;
  errorCode: string | null;
};

type TaskLeaseRow = HostedTaskLeaseMirror & {
  requestFingerprint: string;
};

export type HostedTaskLeaseMutationResult =
  | { success: true; duplicate: boolean; lease: HostedTaskLeaseMirror }
  | {
      success: false;
      errorCode:
        | "AGENT_COORDINATOR_SCOPE_MISMATCH"
        | "AGENT_TASK_LEASE_MIRROR_CONFLICT"
        | "AGENT_TASK_LEASE_MIRROR_INPUT_INVALID";
    };

function taskLeaseFingerprint(input: HostedTaskLeaseMirror): string {
  return JSON.stringify([
    input.requestId,
    input.leaseId,
    input.organizationId,
    input.projectId,
    input.taskId,
    input.agentId,
    input.hostId,
    input.harnessKind,
    input.status,
    input.version,
    input.lastCheckpointSequence,
    input.leaseExpiresAt,
    input.finishedAt,
    input.errorCode,
    input.updatedAt,
  ]);
}

function publicTaskLease(row: TaskLeaseRow): HostedTaskLeaseMirror {
  const { requestFingerprint: _requestFingerprint, ...lease } = row;
  return lease;
}

const pacaAgentRuntimeStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    lastRunId: z.uuid().nullable(),
    lastRunStatus: z
      .enum(["queued", "running", "waiting", "cancelling", "cancelled", "succeeded", "failed"])
      .nullable(),
    lastRunVersion: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type PacaAgentRuntimeState = z.infer<typeof pacaAgentRuntimeStateSchema>;

export type AgentRunMutationResult =
  | {
      success: true;
      duplicate: boolean;
      run: AgentRunRecord;
    }
  | {
      success: false;
      errorCode:
        | "AGENT_COORDINATOR_SCOPE_MISMATCH"
        | "AGENT_RUN_ID_CONFLICT"
        | "AGENT_RUN_IDEMPOTENCY_CONFLICT"
        | "AGENT_RUN_INPUT_INVALID"
        | "AGENT_RUN_NOT_FOUND"
        | "AGENT_RUN_TRANSITION_IDEMPOTENCY_CONFLICT"
        | "AGENT_RUN_TRANSITION_INVALID";
    };

function publicRun(row: RunRow): AgentRunRecord {
  return {
    runId: row.runId,
    idempotencyKey: row.idempotencyKey,
    agentId: row.agentId,
    workflowId: row.workflowId,
    organizationId: row.organizationId,
    projectId: row.projectId,
    documentId: row.documentId,
    kind: row.kind,
    status: row.status,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
    errorCode: row.errorCode,
  };
}

/**
 * One durable Cloudflare Agent per Better Auth Agent ID.
 *
 * PostgreSQL and the run tables below remain the business/audit authorities.
 * Agents SDK state deliberately mirrors only a bounded status summary so it can
 * be traced and recovered without persisting prompts, documents, JWTs, grants,
 * secrets, or harness-specific payloads.
 */
export class AgentCoordinator extends Agent<Env, PacaAgentRuntimeState> {
  override initialState: PacaAgentRuntimeState = {
    schemaVersion: 1,
    lastRunId: null,
    lastRunStatus: null,
    lastRunVersion: 0,
    updatedAt: null,
  };

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    state.blockConcurrencyWhile(async () => {
      state.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS paca_agent_identity (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          agent_id TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS paca_agent_run (
          run_id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          request_fingerprint TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          workflow_id TEXT NOT NULL,
          organization_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          document_id TEXT,
          kind TEXT NOT NULL CHECK (kind = 'document.edit'),
          status TEXT NOT NULL CHECK (
            status IN ('queued', 'running', 'waiting', 'cancelling', 'cancelled', 'succeeded', 'failed')
          ),
          version INTEGER NOT NULL CHECK (version >= 1),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          finished_at INTEGER,
          error_code TEXT
        );
        CREATE INDEX IF NOT EXISTS paca_agent_run_updated_idx
          ON paca_agent_run (updated_at DESC, run_id);
        CREATE TABLE IF NOT EXISTS paca_agent_run_transition (
          transition_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          from_status TEXT NOT NULL,
          to_status TEXT NOT NULL,
          version INTEGER NOT NULL,
          error_code TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (run_id) REFERENCES paca_agent_run(run_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS paca_agent_run_transition_run_idx
          ON paca_agent_run_transition (run_id, version);
        CREATE TABLE IF NOT EXISTS paca_agent_task_lease_mirror (
          lease_id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL,
          request_fingerprint TEXT NOT NULL,
          organization_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          host_id TEXT NOT NULL,
          harness_kind TEXT NOT NULL CHECK (harness_kind = 'cloudflare-agent'),
          status TEXT NOT NULL CHECK (
            status IN ('active', 'cancelled', 'completed', 'expired', 'failed')
          ),
          version INTEGER NOT NULL CHECK (version >= 1),
          last_checkpoint_sequence INTEGER NOT NULL CHECK (last_checkpoint_sequence >= 0),
          lease_expires_at INTEGER NOT NULL,
          finished_at INTEGER,
          error_code TEXT,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS paca_agent_task_lease_mirror_updated_idx
          ON paca_agent_task_lease_mirror (updated_at DESC, lease_id);
      `);
    });
  }

  createRun(value: AgentRunCreate): AgentRunMutationResult {
    const parsed = agentRunCreateSchema.safeParse(value);
    if (!parsed.success) return { success: false, errorCode: "AGENT_RUN_INPUT_INVALID" };
    const input = parsed.data;
    if (!this.assertAgentIdentity(input.agentId)) {
      return { success: false, errorCode: "AGENT_COORDINATOR_SCOPE_MISMATCH" };
    }
    const fingerprint = agentRunCreateFingerprint(input);
    const existing = this.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) {
        return { success: false, errorCode: "AGENT_RUN_IDEMPOTENCY_CONFLICT" };
      }
      this.mirrorRunState(existing);
      return { success: true, duplicate: true, run: publicRun(existing) };
    }
    if (this.findRun(input.runId)) return { success: false, errorCode: "AGENT_RUN_ID_CONFLICT" };

    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO paca_agent_run (
        run_id, idempotency_key, request_fingerprint, agent_id, workflow_id,
        organization_id, project_id, document_id, kind, status, version,
        created_at, updated_at, finished_at, error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 1, ?, ?, NULL, NULL)`,
      input.runId,
      input.idempotencyKey,
      fingerprint,
      input.agentId,
      input.workflowId,
      input.organizationId,
      input.projectId,
      input.documentId ?? null,
      input.kind,
      now,
      now,
    );
    const run = this.findRun(input.runId);
    if (!run) throw new Error("AGENT_RUN_CREATE_FAILED");
    this.mirrorRunState(run);
    return { success: true, duplicate: false, run: publicRun(run) };
  }

  transitionRun(value: AgentRunTransition): AgentRunMutationResult {
    const parsed = agentRunTransitionSchema.safeParse(value);
    if (!parsed.success) return { success: false, errorCode: "AGENT_RUN_INPUT_INVALID" };
    const input = parsed.data;
    const duplicate = this.findTransition(input.transitionId);
    if (duplicate) {
      if (
        duplicate.runId !== input.runId ||
        duplicate.toStatus !== input.status ||
        duplicate.errorCode !== (input.errorCode ?? null)
      ) {
        return {
          success: false,
          errorCode: "AGENT_RUN_TRANSITION_IDEMPOTENCY_CONFLICT",
        };
      }
      const current = this.findRun(input.runId);
      if (!current) return { success: false, errorCode: "AGENT_RUN_NOT_FOUND" };
      this.mirrorRunState(current);
      return { success: true, duplicate: true, run: publicRun(current) };
    }

    const current = this.findRun(input.runId);
    if (!current) return { success: false, errorCode: "AGENT_RUN_NOT_FOUND" };
    if (!canTransitionAgentRun(current.status, input.status)) {
      return { success: false, errorCode: "AGENT_RUN_TRANSITION_INVALID" };
    }

    const now = Date.now();
    const version = current.version + 1;
    const finishedAt = isTerminalAgentRunStatus(input.status) ? now : null;
    const errorCode = input.status === "failed" ? (input.errorCode ?? "AGENT_RUN_FAILED") : null;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `UPDATE paca_agent_run
            SET status = ?, version = ?, updated_at = ?, finished_at = ?, error_code = ?
          WHERE run_id = ? AND version = ?`,
        input.status,
        version,
        now,
        finishedAt,
        errorCode,
        input.runId,
        current.version,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO paca_agent_run_transition (
          transition_id, run_id, from_status, to_status, version, error_code, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        input.transitionId,
        input.runId,
        current.status,
        input.status,
        version,
        errorCode,
        now,
      );
    });

    const run = this.findRun(input.runId);
    if (!run) throw new Error("AGENT_RUN_NOT_FOUND");
    this.mirrorRunState(run);
    return { success: true, duplicate: false, run: publicRun(run) };
  }

  getRuntimeState(): PacaAgentRuntimeState {
    return this.state;
  }

  override validateStateChange(nextState: PacaAgentRuntimeState): void {
    if (!pacaAgentRuntimeStateSchema.safeParse(nextState).success) {
      throw new Error("PACA_AGENT_RUNTIME_STATE_INVALID");
    }
  }

  getRun(runId: string): AgentRunRecord | null {
    const parsed = agentRunCreateSchema.shape.runId.safeParse(runId);
    if (!parsed.success) throw new Error("AGENT_RUN_ID_INVALID");
    const row = this.findRun(parsed.data);
    return row ? publicRun(row) : null;
  }

  listRecentRuns(limit = 20): AgentRunRecord[] {
    const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
    return this.ctx.storage.sql
      .exec<RunRow>(`${this.runSelect()} ORDER BY updated_at DESC, run_id LIMIT ?`, safeLimit)
      .toArray()
      .map(publicRun);
  }

  recordTaskLease(value: HostedTaskLeaseMirror): HostedTaskLeaseMutationResult {
    const parsed = hostedTaskLeaseMirrorSchema.safeParse(value);
    if (!parsed.success) {
      return { success: false, errorCode: "AGENT_TASK_LEASE_MIRROR_INPUT_INVALID" };
    }
    const input = parsed.data;
    if (!this.assertAgentIdentity(input.agentId)) {
      return { success: false, errorCode: "AGENT_COORDINATOR_SCOPE_MISMATCH" };
    }
    const fingerprint = taskLeaseFingerprint(input);
    const current = this.findTaskLease(input.leaseId);
    if (current) {
      if (current.version > input.version) {
        return { success: true, duplicate: true, lease: publicTaskLease(current) };
      }
      if (current.version === input.version) {
        if (current.requestFingerprint !== fingerprint) {
          return { success: false, errorCode: "AGENT_TASK_LEASE_MIRROR_CONFLICT" };
        }
        return { success: true, duplicate: true, lease: publicTaskLease(current) };
      }
      if (
        current.organizationId !== input.organizationId ||
        current.projectId !== input.projectId ||
        current.taskId !== input.taskId ||
        current.agentId !== input.agentId ||
        current.hostId !== input.hostId
      ) {
        return { success: false, errorCode: "AGENT_TASK_LEASE_MIRROR_CONFLICT" };
      }
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO paca_agent_task_lease_mirror (
        lease_id, request_id, request_fingerprint, organization_id, project_id,
        task_id, agent_id, host_id, harness_kind, status, version,
        last_checkpoint_sequence, lease_expires_at, finished_at, error_code, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (lease_id) DO UPDATE SET
        request_id = excluded.request_id,
        request_fingerprint = excluded.request_fingerprint,
        status = excluded.status,
        version = excluded.version,
        last_checkpoint_sequence = excluded.last_checkpoint_sequence,
        lease_expires_at = excluded.lease_expires_at,
        finished_at = excluded.finished_at,
        error_code = excluded.error_code,
        updated_at = excluded.updated_at`,
      input.leaseId,
      input.requestId,
      fingerprint,
      input.organizationId,
      input.projectId,
      input.taskId,
      input.agentId,
      input.hostId,
      input.harnessKind,
      input.status,
      input.version,
      input.lastCheckpointSequence,
      input.leaseExpiresAt,
      input.finishedAt,
      input.errorCode,
      input.updatedAt,
    );
    const lease = this.findTaskLease(input.leaseId);
    if (!lease) throw new Error("AGENT_TASK_LEASE_MIRROR_WRITE_FAILED");
    return { success: true, duplicate: false, lease: publicTaskLease(lease) };
  }

  getTaskLease(leaseId: string): HostedTaskLeaseMirror | null {
    const parsed = hostedTaskLeaseMirrorSchema.shape.leaseId.safeParse(leaseId);
    if (!parsed.success) throw new Error("AGENT_TASK_LEASE_ID_INVALID");
    const row = this.findTaskLease(parsed.data);
    return row ? publicTaskLease(row) : null;
  }

  listTaskLeases(limit = 20): HostedTaskLeaseMirror[] {
    const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
    return this.ctx.storage.sql
      .exec<TaskLeaseRow>(
        `${this.taskLeaseSelect()} ORDER BY updated_at DESC, lease_id LIMIT ?`,
        safeLimit,
      )
      .toArray()
      .map(publicTaskLease);
  }

  private assertAgentIdentity(agentId: string): boolean {
    const [identity] = this.ctx.storage.sql
      .exec<{ agentId: string }>(
        "SELECT agent_id AS agentId FROM paca_agent_identity WHERE singleton = 1",
      )
      .toArray();
    if (identity && identity.agentId !== agentId) return false;
    if (!identity) {
      this.ctx.storage.sql.exec(
        "INSERT INTO paca_agent_identity (singleton, agent_id, created_at) VALUES (1, ?, ?)",
        agentId,
        Date.now(),
      );
    }
    return true;
  }

  private findRun(runId: string): RunRow | null {
    return (
      this.ctx.storage.sql
        .exec<RunRow>(`${this.runSelect()} WHERE run_id = ?`, runId)
        .toArray()[0] ?? null
    );
  }

  private findByIdempotencyKey(idempotencyKey: string): RunRow | null {
    return (
      this.ctx.storage.sql
        .exec<RunRow>(`${this.runSelect()} WHERE idempotency_key = ?`, idempotencyKey)
        .toArray()[0] ?? null
    );
  }

  private findTransition(transitionId: string): TransitionRow | null {
    return (
      this.ctx.storage.sql
        .exec<TransitionRow>(
          `SELECT transition_id AS transitionId, run_id AS runId,
                  to_status AS toStatus, error_code AS errorCode
             FROM paca_agent_run_transition
            WHERE transition_id = ?`,
          transitionId,
        )
        .toArray()[0] ?? null
    );
  }

  private findTaskLease(leaseId: string): TaskLeaseRow | null {
    return (
      this.ctx.storage.sql
        .exec<TaskLeaseRow>(`${this.taskLeaseSelect()} WHERE lease_id = ?`, leaseId)
        .toArray()[0] ?? null
    );
  }

  private mirrorRunState(run: RunRow): void {
    this.setState({
      schemaVersion: 1,
      lastRunId: run.runId,
      lastRunStatus: run.status,
      lastRunVersion: run.version,
      updatedAt: run.updatedAt,
    });
  }

  private runSelect(): string {
    return `SELECT run_id AS runId, idempotency_key AS idempotencyKey,
      request_fingerprint AS requestFingerprint, agent_id AS agentId,
      workflow_id AS workflowId, organization_id AS organizationId,
      project_id AS projectId, document_id AS documentId, kind, status, version,
      created_at AS createdAt, updated_at AS updatedAt, finished_at AS finishedAt,
      error_code AS errorCode FROM paca_agent_run`;
  }

  private taskLeaseSelect(): string {
    return `SELECT request_id AS requestId, lease_id AS leaseId,
      request_fingerprint AS requestFingerprint, organization_id AS organizationId,
      project_id AS projectId, task_id AS taskId, agent_id AS agentId,
      host_id AS hostId, harness_kind AS harnessKind, status, version,
      last_checkpoint_sequence AS lastCheckpointSequence,
      lease_expires_at AS leaseExpiresAt, finished_at AS finishedAt,
      error_code AS errorCode, updated_at AS updatedAt
      FROM paca_agent_task_lease_mirror`;
  }
}
