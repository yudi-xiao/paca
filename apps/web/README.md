# Paca Web App

This package contains the Paca React SPA built with Vite, TanStack Router/Query/Form,
and ShadCN UI components. The Cloudflare internal preview is built with
`VITE_INTERNAL_PREVIEW=true` and served as Static Assets by `services/worker-api`,
so the browser and Better Auth API share one origin.

The internal preview exposes an explicit capability allowlist. Its current migrated surfaces are
home/project CRUD, project Task list/create/search/detail/edit/archive/activity/comments,
Sprint/views/custom fields, project Team and safe Settings, global roles, Organization
role/member access, Better Auth Agent Auth management/device approval, read-only profile, and
password change. Task attachments/links, documents, environments, conversations, automation,
and other legacy-backed routes remain hidden or redirect to `/home` until their Worker contracts
exist, preventing navigation into guaranteed API 404s.

## Run Locally

```bash
bun install
bun --bun run dev
```

## Build

```bash
bun --bun run build
```

For the Cloudflare internal preview:

```bash
VITE_INTERNAL_PREVIEW=true bun run build
cd ../../services/worker-api
PACA_ALLOW_MAIN_DATABASE_FOR_INTERNAL_PREVIEW=true bun run deploy:internal
```

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
