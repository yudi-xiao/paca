# Cloudflare release runbook

Paca's release target is Workers Static Assets + Hono, Better Auth/Paca Permission/Agent Auth,
Hyperdrive/PostgreSQL, R2, Queues, Workflows and separate Durable Object namespaces. Track
completion and evidence in the root [TODO.md](../../TODO.md). The checked-in production
configuration is a candidate and has no public routes.

## Environments and domains

| Environment | Worker | API/web origin after cutover | Environment Gateway |
| --- | --- | --- | --- |
| Local | Default configuration | Localhost | Localhost |
| Internal | `paca-worker-api-internal` | `https://paca-internal.howlearnwood.com` | `paca-environment-gateway-internal` at `https://paca-env-internal.howlearnwood.com` |
| Production | `paca-worker-api-production` | `https://paca.howlearnwood.com` | `paca-environment-gateway-production` at `https://paca-env.howlearnwood.com` |

During candidate preparation, internal still owns both current domains. Production's route
arrays are empty and `workers_dev` is false. A configuration guard rejects taking those domains
early. Do not deploy the default local Worker: its all-zero Hyperdrive ID represents only a local
simulator, supplied with `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`.

Each named environment repeats its non-inheritable bindings. Production has separate R2 buckets,
three source Queues and three dead-letter Queues, two Workflows, Agent/Project/User/Document DO
namespaces, and a Gateway with its own Sandbox and principal/ticket registries. Never reference
another Worker's DO namespace. See [Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/)
and [Hyperdrive local development](https://developers.cloudflare.com/hyperdrive/configuration/local-development/).

## Database and credentials

The production Hyperdrive `98086061f9064f6c8f815303002c4a88` uses a new dedicated runtime role on
the existing `main` branch; internal remains on its independent `internal` branch and Hyperdrive
`ec828e1b80664166ab38aa511cfd1f82`. The former main Hyperdrive is excluded from all checked-in
development/production bindings. Inventory and retire any existing deployed consumer and broad
runtime role before initializing production.

Use versioned PostgreSQL migrations and the explicit runtime grant/verification SQL in
`services/worker-api/scripts/sql/`. The runtime role must have neither broad inherited roles,
schema creation, migration-ledger access, nor database/role administration privileges. Give
migration credentials a short lifetime, transfer object ownership to the stable operator role,
and delete the temporary role after verification. Never pass database URLs/passwords as CLI
arguments, save them in repository configuration, or print auth tokens. Use the project-bound
`paca` Wrangler profile; Cloudflare account IDs are pinned in both configs.

Initialize production from a clean schema with the full migration ledger. Preserve current
internal user/project data. Do not copy internal accounts, passwords, Sessions, Agent/Host keys,
Grants, attachments or business records into production. A current production database inventory
is required before applying the clean-slate plan.

Set independent `BETTER_AUTH_SECRET`, `INTERNAL_HEALTH_TOKEN`, GitHub App credentials and any
Host-enrollment secret for the production Worker. Put Secrets directly in the correct Worker
environment using private operator tooling. The production GitHub App and webhook installation
must be verified against the production callback; internal Secrets are not a production default.
Public email signup is disabled for production and unknown environment labels. The first-owner
operator onboarding flow must be completed and tested before publishing a login page. Do not
open public signup briefly to create the owner or copy a test user's password.

### One-time unpublished production initialization

`bun run db:inspect:production` captures only deployed Hyperdrive consumers and Paca domain
ownership, never Secret bindings. The script listing API returns all scripts (its only optional
filter is tags); a failed settings read fails the inventory. Both the known former-main and new
production Hyperdrive must be unused. Inventory does not retire an unknown non-Worker consumer;
the former broad main role is explicitly retired by initialization.

Create and verify an immediately preceding named backup using the database provider's backup
tool. For this initial clean-slate release, the operator is pinned to `paca/main`, branch ID
`1taj95uxia8x`, and the known pre-release migration baseline through `0014`. Supply the successful
backup ID and explicit initialization confirmation:

```bash
PACA_INITIALIZE_PRODUCTION=INITIALIZE_UNPUBLISHED_PACA_MAIN \
PACA_PRODUCTION_BACKUP_ID=<verified-backup-id> bun run db:initialize:production
PACA_PRODUCTION_OWNER_EMAIL=<owner-email> bun run auth:owner:production
```

These variables contain no passwords. Initialization rejects an old/unfinished backup, wrong
branch, an existing production Worker or a consumed Hyperdrive. It resets the schema, replays
versioned migrations and applies/verifies runtime grants in one transaction. Failure restores the
previous schema. It cannot reset a current migration baseline again and is not a post-release
maintenance command. A temporary TLS-verified operator credential stays in process memory,
expires shortly, transfers ownership to `postgres` and is explicitly deleted on completion.

The owner command verifies the complete ledger, runtime privileges and empty user table before
opening a random one-time URL on `127.0.0.1`. The owner enters their own name and password there.
The page expires after ten minutes and checks exact Host/Origin, email, input size, password
confirmation and concurrent submissions. Account creation, canonical first-owner provisioning
and bootstrap Session revocation share one transaction; failure leaves no partial user or role
assignment. Repeated initialization is rejected. No account password, login cookie or provider credential
is saved, printed or sent to a public endpoint. The local setup URL is shown once for the owner's
direct input and expires shortly. Production stays unpublished until this step and
the remaining candidate validation gates pass.

## Candidate validation

From `services/worker-api`:

```bash
bun run types:check
bun run deploy:guard
bun run deploy:guard:production
bun run typecheck
bun run lint
bun run test
bun run test:workers
bun run build:web:production
bun run deploy:dry-run:production
```

Run the PostgreSQL contracts/recovery exercise against a disposable local `_test` database and
the Gateway's own checks. Then verify actual remote runtime privileges, schema, independent
Secrets, R2 writes/read/deletion, Queue retry/DLQ recovery, Workflow restart/cancellation and DO
revocation. A dry run validates the bundle and binding configuration; it does not validate those
remote resources. The config guard also does not assert remote database state or Secret values.

Use a controlled candidate entry point for same-origin Session/Agent/attachment/collaboration/
search/delivery tests before domain cutover. Browser acceptance must cover real login, project
creation, local Codex/Claude Code work, search, GitHub PR/CI/human acceptance, and error recovery.
Keep the delivery PR in draft until its full acceptance gate passes.

## Cutover and rollback

1. Record internal and production Worker/Gateway versions, current domain owners, the migration
   ledger, backups and restore evidence, outstanding leases/Workflows, operator and stop conditions.
2. Verify the production candidate and owner onboarding, then stop starting new leases while
   the domain change is in progress. Resolve or cancel outstanding work according to the durable
   lease protocol; a domain change must not trigger replay of uncertain shell/PTY operations.
3. Move internal API/web and Gateway domains and their exact auth/public origins to the internal
   hostnames in the table. Existing host-scoped internal cookies do not transfer to the new hostname;
   users sign in again there. Preserve their database and password accounts.
4. Add production's custom domains, keep exact production origins, regenerate types and run
   `bun run deploy:guard:release`. Build production assets with `VITE_PACA_RUNTIME=cloudflare`
   and `VITE_INTERNAL_PREVIEW=false`; disabling test signup must not select the legacy UI.
   Deploy each environment explicitly, then verify domain ownership and all public auth boundaries.
5. Verify the production health and protected database health, create/use a real project, complete
   a real Agent task and fixed-commit GitHub acceptance, and inspect operational/error metrics.
   Record actual versions and evidence in `TODO.md` before declaring the release complete.

On failure, stop new work and roll back only the affected Worker/Gateway versions to the recorded
versions using `wrangler rollback <recorded-version-id> --env <environment>`. Coordinate domain
ownership and auth origins as a separate operation; code rollback alone does not restore domains,
database schemas, queued messages or running Workflows. Never point production at internal's
database/Secrets as a rollback shortcut. Restore database state only through the rehearsed recovery
procedure. Do not reset internal or silently discard new production writes.
