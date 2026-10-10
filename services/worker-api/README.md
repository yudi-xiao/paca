# Paca Worker API

Cloudflare Workers + Hono entrypoint for the incremental Paca API migration. It contains
public liveness, a token-protected Hyperdrive/PostgreSQL health check, the Better Auth route
boundary, the React Cloudflare runtime, and the Drizzle schema/migration baseline.

Native project repository approval and fixed-commit delivery APIs use a dedicated,
read-only GitHub App. See [GitHub delivery setup](../../docs/guides/github-delivery.md)
for permissions, Secret configuration, user API contracts, and recovery behavior.
Release and acceptance status remains in the root `TODO.md`.

## 唯一 prod 部署

只使用根 Wrangler 配置，`ENVIRONMENT=prod`，不使用 `--env`。部署复用现有账号、GitHub App 和所有资源；部分资源的历史物理名字带 `prod` 后缀，不代表另一个环境。

运行 `bun run build:web:production`、`bun run deploy:guard`、`bun run check` 后用 `bun run deploy:prod` 发布。Gateway 先执行其 `deploy:prod`。实际验收使用 `smoke:production`，GitHub App 用 `github:app:verify`。详细资源、凭据、恢复与验收流程见 [单一 prod 发布手册](../../docs/deployment/cloudflare-release.md)。

本地开发通过 Wrangler simulator 和受保护的 `_test` PostgreSQL 运行；不建立远端 development/internal/staging。项目已绑定 Wrangler `paca` auth profile，OAuth 缓存不进入 Git。

## Project body search

Authenticated users search project tasks or documents with
`GET /api/v1/projects/{projectId}/search/{tasks|docs}?q={keyword}&limit=20`.
The user must have `tasks.read` or `docs.read`. Agent Auth clients use the matching
`POST /api/v1/agent/projects/{projectId}/search/{tasks|docs}` with
`{"query":"keyword","limit":20}`; active `task.read`/`document.read` Grants must bind
the project and concrete resource IDs, and delegated users must retain their current permissions.
MCP exposes these routes as `search_tasks` and `search_docs`.

Search performs literal keyword matching on titles, task numbers and BlockNote text. It returns
bounded plain-text snippets and a query-bound `next_cursor`; pass that cursor unchanged for the
next page. It excludes deleted content and arbitrary BlockNote properties, and responses use
`Cache-Control: no-store`. This is keyword search, without semantic ranking. Migration `0037`
requires PostgreSQL's `pg_trgm` extension and creates stored text projections plus partial GIN
indexes; deploy the migration before the Worker.

After building `apps/mcp`, run the prod search/Agent protocol check:

```bash
PACA_PROD_SMOKE_CONFIRM=RUN_PACA_PROD_SMOKE \
PACA_SEARCH_SMOKE_CONFIRM=RUN_PROD_SEARCH_SMOKE \
PACA_PLANETSCALE_ORG={organization-id} \
bun run smoke:search:prod
```

The script fixes both the Worker origin and database branch to `prod`, provisions only its
temporary permission fixtures, exercises public Session/Agent Auth APIs and the built local
MCP process, then revokes identities and cleans up its project/user/private files/database role.
It checks protocol behavior; a real coding task and rendered browser interaction need separate
acceptance.

## GitHub delivery evidence inspection

`bun run github:delivery:inspect` reads a private operator policy file from
`PACA_GITHUB_POLICY_FILE`, a PR number from `PACA_GITHUB_PULL_NUMBER`, and the fixed 40-character
commit SHA from `PACA_GITHUB_HEAD_SHA`. An optional `PACA_GITHUB_INSTALLATION_TOKEN` supplies
read access to private repositories. The policy pins owner/repository, required Check names and
publishing App IDs, trusted reviewer IDs, approval count and maximum Check age.

The reader checks the PR head again after collecting complete, bounded CI/review pages. Missing,
failed, skipped, untrusted or stale checks fail the gate. Its output is inspection evidence with
`humanAcceptance=required`; it does not bind a project, persist an acceptance or close a task.
Native project/Run binding, GitHub App credential provisioning, reliable events and user acceptance
are still separate integration requirements.

## React 与数据库

React 由当前 Worker Static Assets 同源提供；Cloudflare runtime 独立于注册策略，公开测试注册开关已移除。仅显示已迁移 API 支持的入口，未实现能力不通过旧 Go 认证回退。

PostgreSQL 权威数据源为 `paca/prod`（ID 不变）。schema 与 40 份 migration 进入版本控制，runtime role 不允许 DDL 或 migration ledger 访问。部署不会运行 schema push、重建数据库或重复初始化管理员。数据库迁移、测试与恢复步骤见发布手册。

## Better Auth

`BETTER_AUTH_SECRET` is a Cloudflare Secret and must contain at least 32 random characters.
`BETTER_AUTH_URL` and `TRUSTED_ORIGINS` are non-secret Wrangler vars. Browser origins not present
in the trusted list are rejected before a database connection is opened.

The production policy keeps sessions in PostgreSQL for seven days, refreshes them at most
once per day, and disables the cookie session cache so revocation is checked against the database.
HTTPS deployments use `Secure`, `HttpOnly`, `SameSite=Lax` cookies. Cookie-authenticated mutation
requests must also carry a trusted `Origin` header.

```bash
bunx wrangler secret put BETTER_AUTH_SECRET
```

### Delegated Agent Host enrollment

Create the one-time Host enrollment token from the Paca Agent administration page, then run this
command from `services/worker-api` and paste the token at the hidden prompt:

```bash
bun run agent-host:enroll
```

The command first validates the provider discovery document at
`https://paca.howlearnwood.com/.well-known/agent-configuration`, generates a device-local Ed25519
identity, and sends only the public JWK to the enrollment endpoint. The private JWK is written to
the repository root at `.paca/agent-host.json`; that file is Git-ignored, created with mode `0600`,
and is never overwritten automatically. The enrollment token is single-use and is not persisted.
Use `PACA_AGENT_HOST_ORIGIN` or `PACA_AGENT_HOST_CONFIG` only when intentionally targeting another
deployment or key location.

Host enrollment establishes only the Host identity. It does not register an Agent, approve a
device authorization request, or grant any capability. The deployed Paca discovery currently
advertises delegated mode only, and the legacy `services/agent-runner` is not automatically wired
to this Host configuration.

### Autonomous Agent Host bootstrap

Autonomous mode is fail-closed. Discovery advertises only `delegated` unless the deployment has a
high-entropy `AUTONOMOUS_HOST_ENROLLMENT_SECRET` (at least 32 characters). When configured, an
unknown Host may perform Agent Auth dynamic registration only when the registration request also
carries the matching `x-paca-autonomous-host-enrollment` header. The Host JWT must still be a
short-lived, single-use Ed25519 `host+jwt` containing the Host and Agent public JWKs; the bootstrap
secret never replaces JWT signature, audience, expiry, or JTI checks.

```bash
bunx wrangler secret put AUTONOMOUS_HOST_ENROLLMENT_SECRET
```

An autonomous Agent registers active with no capabilities. A user who has
`agents.approveGrant` in the target Project must then grant a constrained capability. The production
Agent management page currently exposes the first minimal path: a 15-minute `project.read` Grant
bound to one Organization and Project. Revocation uses the Paca Better Auth plugin endpoint and is
audited with the approving user as actor. Do not place the bootstrap secret in the browser, a
Worker variable, source control, Agent metadata, or a Capability Grant.

## Internal database health check

Configure the secret independently for the prod environment:

```bash
bunx wrangler secret put INTERNAL_HEALTH_TOKEN
```

Then call `GET /internal/health/database` with `Authorization: Bearer <token>`. The response
contains only health state and latency; database errors and connection details are not returned.

## Production smoke test

After the dedicated existing Hyperdrive and both Worker secrets are configured, set the following
values in the current shell or another ignored secret file:

- `PACA_BASE_URL`: the HTTPS origin of the prod Worker.
- `PACA_HEALTH_TOKEN`: the same value stored in the Worker health-check secret.
- `PACA_SMOKE_EMAIL`: the dedicated test account.
- `PACA_SMOKE_PASSWORD`: at least 12 characters.
- `PACA_SMOKE_NAME`: optional display name.

Then run:

```bash
bun run smoke:prod
```

The script refuses a non-HTTPS or non-`prod` target, does not print credentials, and verifies
public health, Hyperdrive health, sign-up or existing-user sign-in, session lookup, sign-out, and
server-side rejection of the old session cookie.

`bun run smoke:realtime:prod` creates an isolated Project and Task using an existing
project administrator, opens an authenticated Bun WebSocket to ProjectParty, waits for a real
outbox/Queue `task.updated` event, idles for 12 seconds before checking pong, reconnects with a new
capability and verifies another event. Required variables are `PACA_BASE_URL`,
`PACA_REALTIME_SMOKE_EMAIL` and `PACA_REALTIME_SMOKE_PASSWORD`. Optional bounded durations
`PACA_REALTIME_DUPLICATE_WINDOW_MS` and `PACA_REALTIME_ROLLING_WINDOW_MS` keep the client observing
while an operator deliberately requeues the reported smoke outbox ID or deploys a new Worker
version. The duplicate window fails if the same event ID reaches the client twice; after a rolling
deployment the script reconnects if needed, then requires pong and a fresh reliable event. It
archives the temporary Project and revokes its Session in `finally`, while printing exact IDs for
reviewed hard cleanup of the archived fixture and its outbox rows.

`bun run smoke:attachment:prod` verifies the real same-origin attachment path. Set
`PACA_ATTACHMENT_SMOKE_PASSWORD` and optionally `PACA_ATTACHMENT_SMOKE_EMAIL` to reuse an existing
project administrator; without an email it creates a dedicated smoke user. The default
mode covers upload, Range download, soft delete, deleted-list visibility, restore and a second soft
delete. Setting `PACA_ATTACHMENT_SMOKE_MULTIPART_CANCEL_ONLY=true` instead uploads one real 5 MiB
multipart part, aborts it, verifies completion is rejected, and confirms no Task attachment was
created. `PACA_ATTACHMENT_SMOKE_PERMISSION_REVOKE_ONLY=true` creates a temporary human member,
starts a multipart upload as that member, removes the member, verifies the old Session receives
403 for upload/cancel/initiate, restores access only long enough to abort safely, and revokes it
again. All modes create an isolated smoke Project and print exact IDs so generated Project/User
records can be removed with reviewed targets after verification.

`bun run smoke:document:prod` verifies the deployed DocumentParty path with an existing project
administrator. Set `PACA_DOCUMENT_SMOKE_EMAIL` and `PACA_DOCUMENT_SMOKE_PASSWORD`; the script creates
an isolated Project/Document and a fresh delegated Agent with exact `document.read`/`document.edit`
constraints. It covers Agent Auth approval, suggest/collaborate/exclusive operations, user
WebSocket reconnect, lease acquire/renew/release/timeout, user-write blocking, Grant revocation,
user recovery and PostgreSQL materialization. The temporary Agent and Session are revoked and the
Project is archived in independent cleanup steps. The script logs only IDs, revisions and status
codes, never credentials, private keys or document text.

The production deployment has also passed a controlled remote Queue recovery exercise. A temporary
Worker scoped to the smoke Document submitted duplicate/out-of-order revisions followed by one
revision that was deliberately not present in DocumentParty. The consumer ignored the stale work,
retried the not-ready revision through the configured limit, and delivered it to the isolated DLQ;
the PostgreSQL projection and immutable R2 object remained unchanged. The temporary Worker and DLQ
consumer were then removed, and the production Queue bindings were rechecked. Repeat this exercise
only with a newly created smoke Document and a transient, narrowly scoped producer/consumer; never
inject synthetic revisions for a user-owned Document.

## Agent run coordination

`AgentCoordinator` is a server-only SQLite Durable Object addressed by the stable Better Auth Agent
ID. It stores only bounded run scope, lifecycle status, monotonic version, idempotency keys and safe
error codes. It deliberately does not run model inference, tools or long document operations, and it
does not persist JWTs, Grant payloads, document content or execution output. Cloudflare Workflows
own durable execution; authenticated Hono routes and Workflow steps call the coordinator by RPC.
The coordinator itself has no public HTTP or WebSocket route.

Run creation and transitions are independently idempotent. A retry key cannot be reused with a
different run scope or SHA-256 operation fingerprint, each coordinator permanently pins its first
Better Auth Agent ID, and terminal runs cannot be reopened. The hash detects a changed retry payload
without retaining the document operation in the DO. Workers Runtime tests force Durable Object
eviction to verify that these properties come from SQLite rather than process memory.

The first durable definition is the fixed document-edit Workflow
`00000000-0000-4000-8000-000000000201`. An Agent starts, reads or cancels a run through:

```text
POST   /api/v1/agent/projects/:projectId/workflows/:workflowId/runs
GET    /api/v1/agent/projects/:projectId/workflows/:workflowId/runs/:runId
DELETE /api/v1/agent/projects/:projectId/workflows/:workflowId/runs/:runId
```

All three routes require a Better Auth Agent session and a constrained `workflow.execute` Grant.
Starting a document run additionally requires a separately constrained `document.edit` Grant. The
API selects the persisted Grant IDs but never stores the Agent JWT in Workflow parameters. Before
each actual DocumentParty write, the Workflow reloads the Agent and both Grants from PostgreSQL,
checks their current status/expiry/constraints, verifies the active Document scope, and intersects a
delegated Agent with the user's current `docs.write` permission. The write still uses the command's
`requestId` inside DocumentParty, so a retried Workflow step is idempotent.

Cancellation calls Workflow `terminate()` and prevents later steps; it intentionally does not ask
Cloudflare to run a compensating rollback because an already committed Yjs/CRDT edit is not safely
reversible. Applied content remains auditable and a later product-level revert must be represented as
a new document operation. Execution audit rows contain the trusted Agent/run/Grant/scope, action,
mode and bounded outcome only, never document content, JWTs or private keys.

The Workflow smoke reuses the git-ignored delegated Agent config. It first refreshes an
idle Agent session because Agent Auth intentionally clears stale Grants during transparent
reactivation, then creates and bootstraps a temporary Yjs document, issues exact ten-minute Grants,
and verifies success plus both idempotency cases. Cleanup revokes the Grants, waits for the short
lease to expire, archives the document, and signs out:

```bash
PACA_APPROVER_EMAIL='operator@example.com' \
PACA_APPROVER_PASSWORD='…' \
PACA_PROJECT_ID='project-id' \
bun run smoke:agent-workflow:prod
```

The script never prints the password, Agent private key, JWT, Grant payload, or document content.

## Runtime-independent task Harness leases

Cloudflare-hosted Agents and local Codex, Claude Code, DeepSeek or custom Harnesses use the same
Better Auth Agent Auth execution location. `task.execute` is separate from `task.write`: it permits
a Harness to coordinate execution of one exact task, but it does not permit changing task fields or
documents. Those mutations still require their own constrained domain Grants.

Every command includes `organizationId`, `projectId`, `taskId`, `operationMode: "execute"`, a short
`validUntil` and a unique `requestId`. Supported actions are `claim`, `renew`, `checkpoint`,
`complete`, `fail` and `cancel_ack`. A claim also records the bounded Harness kind/version/instance;
the trusted Agent and Host IDs always come from the verified Agent Auth session, never from request
arguments.

PostgreSQL tables `paca_agent_task_lease` and `paca_agent_task_lease_event` are authoritative. They
enforce one active lease per task, monotonic lease versions, strictly increasing checkpoint
sequences and globally idempotent request IDs. The lease expires no later than its active Grant.
AgentDO state remains a bounded coordination mirror and cannot replace this durable record.

Each Host sends a short-lived heartbeat before discovery and lease mutation. Server-approved
labels define the ceiling; effective scheduling labels are the intersection of approved and
currently reported labels and must include `task:execute`. Project approvers can attach additional
required labels to a task. A Harness can therefore report `harness:codex` or `tool:shell`, but the
report alone never grants that capability or broadens an Agent Auth Grant.

For `cloudflare-agent`, a successfully committed lease is idempotently mirrored into the
`AgentCoordinator` AgentDO keyed by the Better Auth Agent ID. The mirror contains only lease IDs,
scope, status, versions and timestamps; it excludes credentials, Grants, task content and prompts.
Local Codex, Claude Code, DeepSeek and custom Harnesses use the same client/protocol without being
routed into that DO. Worker/Agent tracing observes the RPC boundary while PostgreSQL remains the
audit and recovery authority.

Task writers can immediately and idempotently terminate an active execution with
`POST /api/v1/projects/:projectId/tasks/:taskId/agent-lease/cancel`. The one-minute scheduled
recovery pass marks expired leases and leases whose Host heartbeat has expired as `expired`; both
manual cancellation and system expiry append trusted actor events.

The production smoke creates a temporary task and delegated Agent, approves an exact ten-minute
`task.execute` Grant, executes the protocol as a local Codex Harness, checks duplicate and conflict
paths, restart/checkpoint recovery, short-lease reclaim and idempotent manual cancellation, revokes
the Grant, archives the fixture, revokes the Agent and signs out:

```bash
PACA_APPROVER_EMAIL='operator@example.com' \
PACA_APPROVER_PASSWORD='…' \
PACA_PROJECT_ID='project-id' \
bun run smoke:agent-task-harness:prod
```

It never prints credentials, private keys, JWTs or Grant payloads. Protocol failures are returned as
bounded Agent Auth error codes such as `AGENT_TASK_LEASE_CONFLICT`; SQL and arbitrary exception
messages are not exposed.

The scheduled Host-loss recovery path has a separate database-level smoke. It creates a precise
synthetic lease using a 15-minute PlanetScale admin role, temporarily expires only that Host's
heartbeat, waits for the deployed Cron to write an `expire/system` audit event, then deletes the
lease, restores the original Host runtime values and removes the temporary role:

```bash
PACA_AGENT_TASK_RECOVERY_CONFIRM=SMOKE_AGENT_TASK_RECOVERY_INTERNAL \
PACA_PLANETSCALE_ORG='{organization-id}' \
bun run smoke:agent-task-recovery:prod
```

The reusable `AgentTaskHarnessClient` is transport-independent and keeps request IDs under caller
control so an exact retry stays idempotent. Local Harnesses can also send one validated command as
JSON on standard input; the config must belong to an approved Agent that requested `task.execute`:

```bash
PACA_AGENT_CONFIG='/absolute/path/to/agent.json' \
bun run agent:tasks

PACA_AGENT_CONFIG='/absolute/path/to/agent.json' \
bun run agent:task-lease < task-lease-command.json
```

`agent:tasks` calls `GET /api/v1/agent/tasks/claimable` with a one-use Agent JWT. The server derives
the list only from exact active `task.execute` Grants, intersects delegated Agents with the user's
current `tasks.read`, hides work leased by another Agent, and returns the current Agent's own live
lease for resume. Harness self-reported names or labels never add work to this list.

The CLI reads the ignored local Agent key only to mint a short-lived, one-use Agent JWT. It does not
copy the key, JWT or full Grant into command output.

## Deployment and rollback

Use the root config only. `bun run deploy:prod` builds production assets and checks the single prod resource/auth contract before publishing. Public registration, workers.dev and version previews are disabled. Existing Worker Secrets and resource IDs are retained.

```bash
bun run deploy:dry-run
bun run deploy:prod
bunx wrangler versions list
bunx wrangler rollback
```

See the [single prod release runbook](../../docs/deployment/cloudflare-release.md) for actual remote checks, fixture cleanup and database recovery. Do not add a deployment environment or duplicate GitHub App.

## Automation due-date contract

`due_date_reached` uses the task's date-only `due_date` at **00:00 UTC**, plus
`due_date_offset_minutes` (an integer from -525600 through 525600, default 0).
Negative offsets fire before the date, positive offsets after it. The existing
minute Cron Trigger captures up to 50 overdue node/task pairs per invocation;
missed ticks catch up from PostgreSQL without an in-memory cursor.

Migration `0035_cold_steve_rogers` adds a nullable unique schedule key to the
Automation outbox and a partial project/due-date task index. A key identifies
**graph version + trigger node + task + due date**. Concurrent/repeated scans,
Queue retries and completed delivery cannot create a second event for that key.
Postponing to a different date creates a new key when that date becomes due;
clearing a date cancels unplanned events, and restoring an already captured date
within the same graph version does not fire again. Activating an overdue graph
catches up once. Editing the graph creates a new version, eligible for a new run.

Before creating a Run, the consumer checks the exact trigger, offset, graph
version, active graph/project and current live task date. Stopped or changed
graphs and stale/deleted tasks cannot create a new Run. Once a Run is persisted,
its graph snapshot remains the retry authority if Workflow startup fails;
stopping a graph prevents new Runs and does not cancel accepted Runs.
The scheduler writes only PostgreSQL outbox events; Queue/Workflow delivery uses
the existing durable retry and action idempotency paths. Retain schedule keys
when introducing future event-retention jobs to preserve deduplication.

Minute maintenance isolates scanning, realtime delivery and lease recovery:
failed scanning still allows pending Automation delivery, other recovery loops
complete, and a sanitized failure is reported to Cron monitoring. Apply the
migration **before** deploying the new Worker. Until deployment and
real event/browser smoke pass, this capability is locally verified only.

## Automation Cron and Sprint contract

Migration `0036_majestic_white_queen` adds a nullable, indexed
`next_scheduled_at` cursor to each Cron trigger. Activation validates a
**deterministic five-field expression in UTC** and starts at the next matching
minute after activation. Lists, ranges, steps, named months and weekdays are
supported; seconds, macros, random/hash expressions and platform-specific
extensions are rejected. Day-of-month and weekday restrictions use standard
Cron OR semantics. Both API and editor reject impossible calendar expressions.
The parser is pinned to `cron-parser@5.10.1`.

The minute maintenance invocation captures up to **50 due-date pairs and 50 Cron
nodes**, followed by an Automation outbox batch of up to 100. Each Cron node is
locked with `FOR UPDATE SKIP LOCKED`; the event and cursor advance in the same
transaction. A durable key identifies graph version, trigger node and exact
scheduled minute. Repeated ticks do not duplicate an event. If multiple
scheduled minutes were missed, the node captures only the **latest missed
occurrence** and resumes at the next future minute, rather than replaying an
unbounded history. Stopping a graph clears its cursors; reactivation starts from
the next future occurrence. Planning rechecks the graph version, exact trigger,
schedule grid and any configured live, project-scoped target task.

Sprint `created`, `started`, `completed` and `deleted` events are captured by a
PostgreSQL trigger in the same transaction as the lifecycle mutation. Ordinary
edits and repeated writes of the same status do not produce lifecycle events.
Each trigger can optionally filter one Sprint; activation rejects filters from
another project. Archived or deleted projects cannot start new Runs. Deletion
preserves a bounded Sprint snapshot in the outbox and accepted Run, allowing
later condition steps to read the removed Sprint without recreating it. Other
Sprint conditions read the current project-scoped Sprint at execution time.

Sprint Runs and Cron Runs without a target have **no base task**. They may wait,
evaluate Sprint fields, or read/update an explicitly selected other task.
Activation rejects relative task actions/conditions reachable from such
triggers, and runtime guards reject invalid persisted self-update paths. The
editor follows the same reachability rules and offers localized input errors,
Sprint filters, deleted-filter warnings and a retry action for failed loading.
PostgreSQL contracts verify mutations, scope, rollback and concurrency; Workers
runtime tests exercise the production Workflow graph with database steps
replaced by the official introspector. Database behavior is tested separately.

Before rolling back to a Worker that does not recognize the new event types,
stop these graphs and drain accepted Runs. Keep the additive migrations and
durable outbox records; do not roll back the database schema.

Official API reference: [Workflows test introspection](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/).

Apply `0035` and `0036` before deploying the Worker. These new capabilities have
passed local verification; target-account deployment and real browser/event
smoke tests are still required before declaring them available online.
