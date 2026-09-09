# Services

This directory contains backend runtime services.

## Services

- `api` — Go + Gin application backend (business logic, REST API, WASM plugin runtime).
- `realtime` — Node.js + Socket.IO real-time event fan-out.
- `agent-runner` — Go AI agent execution service (Goose over ACP; also brokers `acp`-type dispatch to `apps/acp-bridge`).
- `agent-server` — Docker image for the Goose sandbox `agent-runner` spawns per conversation.
- `worker-api` — Cloudflare Worker + Hono API、Better Auth、Agent Auth、PartyServer、Queues 与 Workflows 的迁移目标服务。
- `environment-gateway` — Worker API 与隔离执行环境之间的版本化私有边界；当前通过 Service Binding 接入 Cloudflare Sandbox provider。

Service boundaries are documented in [../docs/architecture/service-boundaries.md](../docs/architecture/service-boundaries.md).
