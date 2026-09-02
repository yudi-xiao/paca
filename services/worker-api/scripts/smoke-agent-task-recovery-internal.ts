import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import pg from "pg";

const execFileAsync = promisify(execFile);
const organization = process.env.PACA_PLANETSCALE_ORG?.trim();
const database = process.env.PACA_PLANETSCALE_DATABASE?.trim() || "paca";
const branch = process.env.PACA_PLANETSCALE_TARGET_BRANCH?.trim() || "internal";
const expectedConfirmation = "SMOKE_AGENT_TASK_RECOVERY_INTERNAL";
const workerDirectory = resolve(import.meta.dirname, "..");

type RolePayload = {
  id?: unknown;
  database_url?: unknown;
  password?: unknown;
};

type Candidate = {
  agentId: string;
  hostId: string;
  organizationId: string;
  projectId: string;
  taskId: string;
};

type RuntimeSnapshot = {
  approvedLabels: string[];
  reportedLabels: string[];
  reportedHarnessKinds: string[];
  lastHeartbeatAt: Date | null;
  heartbeatExpiresAt: Date | null;
  updatedAt: Date;
};

function redact(value: string): string {
  return value
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s/]+@/giu, "$1[REDACTED]@")
    .replace(/("password"\s*:\s*")[^"]+/giu, "$1[REDACTED]")
    .slice(0, 4_000);
}

async function pscale(args: string[], allowFailure = false): Promise<string> {
  try {
    return (
      await execFileAsync("pscale", [...args, "--org", organization ?? "", "--format", "json"], {
        cwd: workerDirectory,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout;
  } catch (error) {
    if (allowFailure) return "";
    const failure = error as Error & { stdout?: string; stderr?: string };
    throw new Error(
      `PSCALE_FAILED: ${redact(failure.stderr || failure.stdout || failure.message)}`,
    );
  }
}

function parseRole(value: string): { id: string; databaseURL: string } {
  const role = JSON.parse(value) as RolePayload;
  if (typeof role.id !== "string" || typeof role.database_url !== "string") {
    throw new Error("TEMP_RECOVERY_ROLE_INVALID");
  }
  const url = new URL(role.database_url);
  if (!url.password && typeof role.password === "string") url.password = role.password;
  if (!url.password) throw new Error("TEMP_RECOVERY_ROLE_PASSWORD_MISSING");
  url.searchParams.delete("sslrootcert");
  url.searchParams.delete("sslmode");
  return { id: role.id, databaseURL: url.toString() };
}

async function main(): Promise<void> {
  if (process.env.PACA_AGENT_TASK_RECOVERY_CONFIRM !== expectedConfirmation) {
    throw new Error(`PACA_AGENT_TASK_RECOVERY_CONFIRM must equal ${expectedConfirmation}`);
  }
  if (!organization) throw new Error("PACA_PLANETSCALE_ORG_REQUIRED");
  if (branch !== "internal") throw new Error("TARGET_BRANCH_MUST_BE_INTERNAL");

  const role = parseRole(
    await pscale([
      "role",
      "create",
      database,
      branch,
      `paca-recovery-smoke-${Date.now()}`,
      "--inherited-roles",
      "postgres",
      "--ttl",
      "15m",
    ]),
  );
  const client = new pg.Client({
    connectionString: role.databaseURL,
    ssl: { rejectUnauthorized: true },
  });
  const leaseId = crypto.randomUUID();
  let candidate: Candidate | null = null;
  let runtimeSnapshot: RuntimeSnapshot | null = null;
  let runtimeExisted = false;
  try {
    await client.connect();
    await client.query("BEGIN");
    const candidateResult = await client.query<Candidate>(`
      SELECT a.id AS "agentId", h.id AS "hostId", p.organization_id AS "organizationId",
             t.project_id AS "projectId", t.id AS "taskId"
        FROM agent a
        JOIN agent_host h ON h.id = a.host_id AND h.status = 'active'
        JOIN paca_task t ON t.deleted_at IS NULL
        JOIN paca_project p ON p.id = t.project_id AND p.status = 'active'
       WHERE a.status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM paca_agent_task_lease l
            WHERE l.task_id = t.id AND l.status = 'active'
         )
       ORDER BY a.created_at, t.created_at
       LIMIT 1
       FOR UPDATE OF t
    `);
    candidate = candidateResult.rows[0] ?? null;
    if (!candidate) throw new Error("RECOVERY_SMOKE_CANDIDATE_NOT_FOUND");

    const runtimeResult = await client.query<RuntimeSnapshot>(
      `
      SELECT approved_labels AS "approvedLabels", reported_labels AS "reportedLabels",
             reported_harness_kinds AS "reportedHarnessKinds",
             last_heartbeat_at AS "lastHeartbeatAt",
             heartbeat_expires_at AS "heartbeatExpiresAt", updated_at AS "updatedAt"
        FROM paca_agent_host_runtime WHERE host_id = $1 FOR UPDATE
    `,
      [candidate.hostId],
    );
    runtimeSnapshot = runtimeResult.rows[0] ?? null;
    runtimeExisted = runtimeSnapshot !== null;
    const staleHeartbeat = new Date(Date.now() - 60_000);
    await client.query(
      `INSERT INTO paca_agent_host_runtime (
         host_id, approved_labels, reported_labels, reported_harness_kinds,
         last_heartbeat_at, heartbeat_expires_at, updated_at
       ) VALUES ($1, '["task:execute"]'::jsonb, '["task:execute", "harness:codex"]'::jsonb,
                 '["codex"]'::jsonb, $2, $3, now())
       ON CONFLICT (host_id) DO UPDATE SET
         approved_labels = CASE
           WHEN paca_agent_host_runtime.approved_labels ? 'task:execute'
             THEN paca_agent_host_runtime.approved_labels
           ELSE paca_agent_host_runtime.approved_labels || '["task:execute"]'::jsonb
         END,
         reported_labels = '["task:execute", "harness:codex"]'::jsonb,
         reported_harness_kinds = '["codex"]'::jsonb,
         last_heartbeat_at = $2,
         heartbeat_expires_at = $3,
         updated_at = now()`,
      [candidate.hostId, new Date(staleHeartbeat.getTime() - 60_000), staleHeartbeat],
    );
    await client.query(
      `INSERT INTO paca_agent_task_lease (
         id, organization_id, project_id, task_id, agent_id, host_id,
         harness_kind, harness_version, harness_instance_id, status, version,
         last_checkpoint_sequence, lease_expires_at, claimed_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'codex', 'recovery-smoke', $7,
                 'active', 1, 0, now() + interval '10 minutes', now(), now(), now())`,
      [
        leaseId,
        candidate.organizationId,
        candidate.projectId,
        candidate.taskId,
        candidate.agentId,
        candidate.hostId,
        `recovery-smoke-${leaseId}`,
      ],
    );
    await client.query("COMMIT");

    const deadline = Date.now() + 90_000;
    let recovered = false;
    while (Date.now() < deadline) {
      const state = await client.query<{ status: string }>(
        "SELECT status FROM paca_agent_task_lease WHERE id = $1",
        [leaseId],
      );
      if (state.rows[0]?.status === "expired") {
        recovered = true;
        break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
    }
    if (!recovered) throw new Error("SCHEDULED_RECOVERY_TIMEOUT");
    const audit = await client.query<{ action: string; actorType: string }>(
      `SELECT action, actor_type AS "actorType"
         FROM paca_agent_task_lease_event
        WHERE lease_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [leaseId],
    );
    if (audit.rows[0]?.action !== "expire" || audit.rows[0].actorType !== "system") {
      throw new Error("SCHEDULED_RECOVERY_AUDIT_INVALID");
    }
    console.log(
      JSON.stringify({
        status: "ok",
        step: "agent-task-recovery-smoke",
        leaseId,
        recoveredBy: "host-heartbeat-expiry",
        auditActor: "system",
      }),
    );
  } finally {
    if (candidate) {
      await client.query("BEGIN").catch(() => undefined);
      await client
        .query("DELETE FROM paca_agent_task_lease WHERE id = $1", [leaseId])
        .catch(() => undefined);
      if (runtimeExisted && runtimeSnapshot) {
        await client
          .query(
            `UPDATE paca_agent_host_runtime SET
               approved_labels = $2, reported_labels = $3, reported_harness_kinds = $4,
               last_heartbeat_at = $5, heartbeat_expires_at = $6, updated_at = $7
             WHERE host_id = $1`,
            [
              candidate.hostId,
              JSON.stringify(runtimeSnapshot.approvedLabels),
              JSON.stringify(runtimeSnapshot.reportedLabels),
              JSON.stringify(runtimeSnapshot.reportedHarnessKinds),
              runtimeSnapshot.lastHeartbeatAt,
              runtimeSnapshot.heartbeatExpiresAt,
              runtimeSnapshot.updatedAt,
            ],
          )
          .catch(() => undefined);
      } else {
        await client
          .query("DELETE FROM paca_agent_host_runtime WHERE host_id = $1", [candidate.hostId])
          .catch(() => undefined);
      }
      await client.query("COMMIT").catch(() => undefined);
    }
    await client.end().catch(() => undefined);
    await pscale(["role", "delete", database, branch, role.id, "--force"], true);
  }
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      status: "error",
      step: "agent-task-recovery-smoke",
      code: error instanceof Error ? redact(error.message) : "UNKNOWN_ERROR",
    }),
  );
  process.exitCode = 1;
});
