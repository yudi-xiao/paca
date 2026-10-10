# Paca Web App

This package contains the Paca React SPA built with Vite, TanStack Router/Query/Form,
and ShadCN UI components. The single prod deployment builds with
`VITE_PACA_RUNTIME=cloudflare` and serves Static Assets through `services/worker-api`,
so the browser and Better Auth API share one origin. Public signup is disabled.

The Cloudflare runtime exposes routes backed by migrated Worker APIs, including
projects, tasks and documents, body search, sprints, members and roles, Agent Auth,
environments, automation and GitHub delivery settings. Unsupported legacy pages
redirect to `/home`. This capability boundary does not create a separate deployment.

## Run Locally

```bash
bun install
bun --bun run dev
```

## Build

```bash
bun --bun run build
```

For the single Cloudflare prod deployment:

```bash
cd ../../services/worker-api
bun run deploy:prod
```

Deployment resources and credential reuse are documented in
[the release runbook](../../docs/deployment/cloudflare-release.md).

## Test

```bash
bun --bun run test
```

## Lint and Format

```bash
bun --bun run lint
bun --bun run format
bun --bun run check
```

## Project Notes

- Routing uses TanStack file-based routes in `src/routes`.
- Shared app shell is defined in `src/routes/__root.tsx`.
- ShadCN primitives are in `src/components/ui`.
