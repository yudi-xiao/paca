# Paca Cloudflare 重构工程进度

本文件是 Cloudflare 重构的唯一工程进度清单。目标架构和不可违反的约束以根目录 [`AGENTS.md`](./AGENTS.md) 为准；这里只记录当前状态、剩余工作和验收条件。

## 使用规则

- `[ ]` 表示未完成；`[x]` 表示代码、测试、迁移和必要文档已达到当前阶段验收条件。
- 已完成内容按能力合并记录，不保留逐次部署版本号、临时测试数据、测试数量或重复烟测流水。
- 数据库重建、远端部署、Secret 修改和删除旧服务属于外部状态变更，必须确认目标环境并保留可重放的 schema 与部署版本；当前不保留 legacy 数据回滚路径。
- 不在日志、提交或本文档中记录数据库连接串、Better Auth Secret、Agent 私钥等凭据。
- PostgreSQL 是默认主线；D1 是独立实验路线，不阻塞默认主线。

## 当前状态

更新时间：2026-09-11

当前可用基线：**M1～M9 的核心路径已形成 internal 纵向切片；当前优先收尾 M4 权限单权威切换、M5 Runner 身份迁移和剩余 API。**

- internal 入口为 `https://paca.howlearnwood.com`，React Static Assets、Hono API、Better Auth、Hyperdrive、R2、PartyServer/DO、Queues、Workflows、Agents SDK 与 Cloudflare Sandbox 已连通。
- `paca/internal` 已通过 clean-slate 工具从空 schema 重放，并继续应用至 `0028_unknown_thunderbolts.sql`；29 项 ledger 完全匹配、Better Auth 用户数为 0，legacy attachment migration 账本和 `legacy-agent-runner` Environment backend 已删除。`paca/main` 仍停在 `0014`。internal Worker runtime role 仅拥有 47 张业务表 CRUD，不可访问迁移账本。
- Agent Auth 的用户审批、Agent/Host、受约束 Grant、任务/文档/环境执行、审计和撤销边界已可用；`capability.executed` 以真实 Agent 为 actor，delegated 用户仅保留为委托上下文。
- PostgreSQL 测试流程已能从空库应用 28 个 migration，并覆盖 migration ledger、clean-slate schema、前滚恢复演练和 repository contract。
- 当前仍处于未上线开发期，用户已明确允许清空并重建数据；不迁移 legacy User/密码/Session/JWT、旧附件或其他历史业务数据。Better Auth 与 Worker schema 是新环境唯一基线。

### 当前优先顺序

1. 完成 Worker 领域路由权限审计并推进 Better Auth 单权威切换。
2. 部署 Runner Agent Auth 身份配置，完成后删除对应 legacy `PACA_API_KEY` 回退路径。
3. 在 Worker 中重建 Agent Conversation、Automation 和剩余 Environment/API 能力；不迁移旧数据。
4. 完成真实浏览器 BlockNote 与 Sprint/View E2E。

### 已知阻塞或待人工验收

- [ ] 在 Hyperdrive dashboard 确认查询和连接指标。
- [ ] 用真实登录浏览器完成 Sprint 生命周期、自定义字段和 View CRUD E2E。
- [ ] 用真实浏览器完成 BlockNote 协作编辑、刷新恢复及 Agent 独占时只读提示验收。

## M1：Worker、Hono 与 Hyperdrive 基础

- [x] 建立独立 `services/worker-api`，包含 Hono、类型化 Wrangler bindings、统一错误/request ID/结构化日志和公开健康检查。
- [x] Worker 仅使用 `env.HYPERDRIVE.connectionString`，按请求创建并关闭 PostgreSQL client；数据库错误不会泄露连接信息。
- [x] internal Worker、独立 Hyperdrive、自定义域名和真实数据库健康检查已通过；部署守卫拒绝复用根环境 Hyperdrive。
- [x] 本地测试、`wrangler dev`、dry-run 和并发 Hyperdrive smoke 已通过，并记录部署/回滚入口。
- [ ] 在 Cloudflare dashboard 人工确认 Hyperdrive 指标可见。

## M2：Drizzle Schema 与迁移基线

- [x] 建立 PostgreSQL Drizzle schema、独立配置、版本化 SQL migration、snapshot checksum 和 migration ledger；生产启动不自动改表。
- [x] 建立受确认串保护的 internal provisioning/migration 流程，使用短时 admin role；runtime role 无 DDL 和迁移账本权限。
- [x] CI 在受保护的本地 `_test` PostgreSQL 从空 schema 顺序应用全部已提交 migration，并核对 ledger/checksum。
- [x] 建立可供 PostgreSQL/D1 adapter 复用的 repository contract 基础，已覆盖 Project CRUD、分页/统计、唯一性和事务回滚。
- [x] 已演练失败 transaction 无残留以及 additive migration 前滚修复保留数据；不提供破坏性 down migration。
- [ ] 验证 PlanetScale branch 的备份、恢复和回滚策略，并形成可重复运行手册。
- [x] 已提供并实际执行受精确确认串保护的 clean-slate 重建工具：仅允许 `paca/internal`，预检连续 migration 序列，重放全部 migration、恢复并验证 runtime role 最小权限；随后经 Hyperdrive 完成临时 Better Auth 注册、Session 和 `/api/me` 验收并级联清理，最终用户数为 0。

## M3：Better Auth Core

- [x] Better Auth `/api/auth/*`、`GET /api/me`、PostgreSQL adapter、可信 Origin、Cookie/CORS 和 Session 撤销已接入 Hono。
- [x] Better Auth Core/Organization schema 已进入版本化 migration；internal Secret 仅以 Worker Secret 保存。
- [x] 注册、登录、Session、登出、伪造/过期/撤销 Session 和同源边界已通过协议及远端测试。
- [x] React 登录、注册、当前用户、修改密码和登出均使用 Better Auth API。
- [x] 开发期采用 clean-slate 策略：不兼容或迁移 legacy User、bcrypt 密码、Session/JWT 和 ID；重建后用户通过 Better Auth 重新注册，密码仅使用 Better Auth 当前算法。

## M4：Paca Permission Better Auth 插件

- [x] `pacaPermission` 已成为 Better Auth 的 system/organization/project 权限扩展；Project 不映射为 Organization 或 Team。
- [x] 已实现静态 resource/action statement、动态系统/组织/项目角色、角色分配、grant ceiling、内置角色和最后管理员保护。
- [x] 已实现类型化权限 API、Hono 统一中间件和前端能力展示；服务端始终是最终授权边界。
- [x] 项目成员可在不同项目拥有不同角色；角色/成员/项目变更会使 HTTP、PartyServer 和 Environment 连接失效。
- [x] Worker 权限边界审计已固化为 CI：自动枚举全部 Hono 业务路由并验证匿名请求在领域 runtime 前返回 401；权限成员表仅允许指定 permission/access adapter 访问，普通领域服务不能形成第二套 RBAC。
- [x] 旧 Go Authorizer 与 Better Auth evaluator 已共用版本化 shadow decision corpus，覆盖全局/项目权限、多角色、wildcard、无成员和 legacy Agent 样本。
- [x] 已删除 Go 对 JWT legacy `role` claim 的授权 fallback，修复 `ADMIN` 在旧入口被错误扩成全局 `*` 的差异；共享 corpus 与 Go/Worker 回归均通过。
- [ ] 将 Better Auth/`pacaPermission` 切换为唯一用户权限权威来源。
- [ ] 删除或正式接管旧 `PermissionStore`、`Authorizer`、legacy role 合并及重复权限 schema，确认无长期双写/双权威。

## M5：Better Auth Agent Auth

- [x] 锁定 `@better-auth/agent-auth@0.6.2` 并以适配层隔离；Agent、Host、Grant、Approval、JTI 和审计已纳入 migration。
- [x] 已实现 delegated/autonomous 注册、审批、发现、短期 JWT、防重放、最小 Grant、constraints 和实时 delegated 权限交集。
- [x] Agent 可按真实 Agent actor 执行 Project/Task、Document/Yjs、Environment 和 Document Workflow 能力；撤销会关闭相应 lease/连接。
- [x] Device authorization、Host enrollment CLI、Agent 管理/审批 UI 和 Agent Auth 审计已通过真实协议测试。
- [x] 本机 Harness 与 managed Sandbox 使用分离凭据：本机读取 `0600` Ed25519 身份，Sandbox 只获得 Project-scoped opaque broker bearer。
- [x] Agent Auth Runner 启动边界已 fail-closed：一个实例只接受 enrollment 文件中的单一 Agent，禁止 `*` gate 和同进程 `PACA_API_KEY` 回退。
- [ ] 补充通用业务 Workflow 领域执行器，以及浏览器文件/SSH/Port Forward 契约；旧 Environment 数据直接舍弃。
- [ ] 将 `services/agent-runner` 正式部署为 Agent Auth 身份：完成 Host 配置、delegated Agent 审批、JWT 轮换和 Project-scoped Capability 执行。
- [ ] 为 managed Sandbox 的 repository/plugin 能力接入 Agent Auth，并在 rollout 完成后全局删除 legacy `PACA_API_KEY` 回退路径。

## M6：R2 文件与附件

- [x] development/internal/production bucket 已创建；development/internal binding、环境隔离守卫和 internal 定时清理已完成。
- [x] 附件使用 R2 保存对象、PostgreSQL 保存作用域/哈希/ETag/状态；上传、Range 下载、软删除、恢复和分片取消均受 Paca Permission 保护。
- [x] 已实现保留期、stale claim、失败重试和孤儿审计；clean-slate 决策后已删除历史附件迁移 CLI、运行手册和专用账本 schema。
- [x] internal 真实 smoke 已覆盖小文件、multipart、重复/取消、权限撤销、恢复和物理清理。
- [ ] 在生产 Worker/Hyperdrive 建立后接入并验收 production R2 binding。

## M7：PartyServer 实时事件

- [x] ProjectParty/UserParty 已替代已迁移域的 Socket.IO room，使用稳定 room name、DO SQLite 和 WebSocket Hibernation。
- [x] 用户 Session 与 Agent Auth 在路由前鉴权；连接绑定 actor/scope/action/expiry/nonce/权限版本并支持精确撤销。
- [x] PostgreSQL outbox → Queue → PartyServer 提供可靠、幂等、可重试投递；广播本身不作为队列。
- [x] 已覆盖休眠恢复、重连、滚动发布、权限撤销、重复/乱序消息和 DLQ 故障注入。

## M8：Yjs DocumentParty

- [x] 一篇文档对应一个稳定 `documentId` 的 DocumentParty/YServer；DO SQLite 保存增量/checkpoint，R2/PostgreSQL 保存长期快照与可查询投影。
- [x] 用户检查 `docs.read/write`，Agent 检查精确 `document.read/edit` Grant；支持 suggest/collaborate/exclusive 与撤销。
- [x] Agent 文档写入使用受限 block 操作、base revision/state vector、block version、run/request ID，拒绝无条件整篇覆盖。
- [x] 已覆盖单用户、单 Agent、用户+Agent、冲突、断线重连、checkpoint 驱逐恢复、幂等和物化失败/DLQ。
- [ ] 完成真实浏览器 BlockNote 编辑、刷新恢复和 Agent 独占只读 UI 验收后，才宣称前端协作链路完整。

## M9：Agent 编排与执行环境

- [x] AgentCoordinator 以 Better Auth Agent ID 稳定命名，只保存有界 run 摘要；PostgreSQL 是 Agent/Grant/lease/checkpoint/event/audit 权威。
- [x] Workflows 负责持久步骤、重试、取消和恢复；AgentDO/Workflow 在敏感操作前重查 Grant、constraints 和 delegated 权限。
- [x] `task.execute` lease 支持 claim/renew/checkpoint/complete/fail/cancel，具有单 active lease、单调版本和 request ID 幂等约束。
- [x] Cloudflare Agent、Codex、Claude Code、DeepSeek/custom Harness 共用任务协议、能力标签和调度契约。
- [x] 私有 Environment Gateway 已接入稳定 Cloudflare Sandbox，提供 Project-scoped 资源、按需启动、浏览器/Agent 双主体 PTY、一次性票据和精确撤销；clean-slate schema 已禁止新建 `legacy-agent-runner` backend。
- [x] Provider 错误已归一为脱敏稳定码；仅明确可重试的 prepare/read 使用固定 request ID 和有限预算，结果不确定的终端操作不自动重放。
- [x] Cloudflare Agent Tracing 已开启且不记录 prompt/JWT/Grant/正文；PostgreSQL 审计继续作为业务权威。

## M10：API 与前端逐步切换

- [x] 已建立 Go API → Hono Worker 迁移清单、机器可检查 manifest、稳定 501 未迁移边界和 Worker 版本回滚策略。
- [x] React 保留 TanStack Router/Query/Form；Static Assets 与 `/api/*` 同源，SPA 深链与懒加载版本错位可恢复。
- [x] 已迁移 Project、Organization/Project 访问控制、Task/Activity/Link、Sprint/View/Custom Field、高级任务查询、首页我的任务、Project Agent 目录、Notification、Workspace Branding、Attachment、Document 和 Environment 纵向切片。
- [x] 未迁移页面由统一能力清单隐藏/重定向，不再先请求 legacy API 导致 404。
- [ ] 持续按“认证与只读 → 边界清晰写入 → 复杂事务”的顺序迁移剩余 API。
- [ ] 为仍需保持产品行为的模块补充新旧 API contract；不要求历史数据迁移或双写一致性。
- [ ] 完成真实浏览器 Sprint 生命周期、自定义字段和 View CRUD E2E。
- [ ] 迁移 Paca Agent Conversation/Automation 与剩余 legacy Environment 能力后，关闭对应 501 domain。

## M11：旧实时与 Valkey 退役

- [ ] 让 PartyServer、Queues、Workflows 覆盖所有仍需要的 Socket.IO 与 Valkey Pub/Sub/Streams 行为。
- [ ] 完成并发、顺序、重复投递、重连和故障恢复压测。
- [ ] 停止 legacy 新写入并观察一个完整回滚窗口。
- [ ] 移除 Socket.IO、对应 Valkey Pub/Sub/Streams 和无用部署配置。
- [ ] 保留仍有明确用途的缓存；不为追求“完全 Cloudflare”删除必要缓存能力。

## M12：D1 独立实验路线

- [ ] 建立独立 SQLite/D1 schema、migration 和 repository adapter，不复用 PostgreSQL SQL。
- [ ] 适配 UUID、JSON、FTS5、batch/事务、并发和 read replication Sessions。
- [ ] 对 PostgreSQL 与 D1 运行同一组 repository contract tests。
- [ ] 验证 Better Auth Core、`pacaPermission` 和 Agent Auth 的完整等价语义。
- [ ] 明确 PostgreSQL 专有能力的替代方案或不支持范围。
- [ ] 只有通过功能、并发、恢复和权限测试的模块才可声明支持 D1。

## 跨阶段质量门槛

- [x] CI 已覆盖 Worker 类型、Biome、Drizzle migration、单元测试、React internal build、Wrangler types/dry-run 和 PostgreSQL 集成测试。
- [x] PostgreSQL migration/recovery、Paca Permission、Agent Grant、Queue 幂等和 Yjs 恢复均已有独立测试套件。
- [x] internal 已隔离数据库 branch、Hyperdrive、R2 bucket、Secrets 和关键 Queue/DO namespace；部署守卫拒绝与根环境混用。
- [x] 无凭据 internal smoke 覆盖 health、Hyperdrive、注册/登录、Session、登出和旧 Cookie 撤销。
- [ ] 在生产环境建立独立数据库/Hyperdrive、R2、Secrets、Queues、Workflows、DO namespace 和回滚版本。
- [ ] 审计所有日志均含 request ID，Agent/Workflow/文档操作均含 run ID 和可信 actor。
- [ ] 建立 Worker、Hyperdrive、DO、Queues、Workflows、R2 和 PostgreSQL 的统一可观测性与告警。
- [ ] 完成数据库恢复、权限误配、Agent Grant 泄露、DO 状态损坏和队列积压运行手册。
- [ ] 每次切流前记录回滚负责人、Worker 版本回滚命令、clean-slate 重建命令和停止条件。

## 当前代码落点

- `services/worker-api`：Hono Worker、Better Auth/Paca Permission/Agent Auth、Hyperdrive/Drizzle、PartyServer、DocumentParty、Queues、Workflows、AgentDO 和 Environment API。
- `services/worker-api/drizzle`：PostgreSQL schema migration、snapshot 和 clean-slate 数据库基线。
- `apps/web`：React + TanStack Router/Query/Form，以及 BlockNote + Yjs/PartySocket 前端。
- `services/agent-runner`：legacy Runner 与进行中的 Agent Auth/Harness 迁移。
- `apps/mcp`：本机 Agent Auth 与 managed Sandbox Capability Broker 工具边界。
- `services/api`：尚未退出的 Go API、legacy PostgreSQL repository 和旧 Authorizer。
- `services/realtime`：待 M11 完全退役的 Socket.IO/Valkey 行为基线。
- `docs/cloudflare-api-migration.md`：API 领域迁移清单和退出依赖。
