# Paca Cloudflare 原生重构指南

本文档描述将 Paca 从当前的 React Web、Go API、Socket.IO、PostgreSQL、Valkey、对象存储和 Agent Runner 架构，逐步迁移为以 Cloudflare 为主要运行平台、以 Hono + Better Auth 为 API 与认证授权边界、以可通过 Hyperdrive 接入的 PostgreSQL 为默认核心业务数据库的目标方案。数据库供应商不是架构约束，同时允许提供经过完整适配和验证的 D1 部署模式。

后续修改本项目时，应把本文档视为架构约束。涉及 Cloudflare 产品能力、限制、价格或 API 时，必须先核对当时的 Cloudflare 官方文档，不要依赖旧版本记忆。工程阶段、任务状态、当前代码落点和验收记录统一维护在根目录 `TODO.md`；不要在本文档中维护实施进度或完成勾选。

## 一、目标与基本原则

目标不是把现有容器原封不动搬到 Cloudflare，而是按 Cloudflare 的运行模型重构：

- React Web 部署到 Workers Static Assets 或 Pages，保留并复用现有 TanStack Router、TanStack Query 和 TanStack Form；没有明确收益时不迁移到 TanStack Start。
- 对外 API 逐步从 Go 服务迁移到 Workers + TypeScript + Hono；暂未迁移的 Go API 可保留在现有环境，通过 API 边界过渡。
- Better Auth 是唯一的用户与 Agent 认证授权体系：用户通过 Session 与 Paca 领域权限插件授权，Agent 通过 Better Auth Agent Auth 的身份、Capability Grant 和约束授权。
- 默认使用任意能通过 Hyperdrive 稳定接入的 PostgreSQL 或 PostgreSQL 协议兼容数据库作为业务数据的权威来源，不绑定具体云服务商。
- 实时协调优先使用 Cloudflare 的 PartyServer/PartyKit 生态，其底层仍是 Durable Objects，不再依赖中心化 Socket.IO 房间服务。
- 文件和附件迁移到 R2。
- 后台可靠任务使用 Queues 和 Workflows。
- Agent 的身份鉴权、控制面、持久编排、可观测性和 Harness 必须分层：Better Auth Agent Auth 负责 Agent/Host 身份与 Capability Grant，Cloudflare Agents SDK 的 AgentDO 保存有界运行状态，Workflows 负责持久编排，Agent Tracing 负责运行观测；Cloudflare 托管 Agent、本地 Codex、Claude Code、DeepSeek harness 等执行端通过同一套 Paca Agent 协议消费任务。

核心原则：

1. 不把 KV 当成 Valkey 的等价替代。KV 适合配置、缓存和低频会话读取，不适合强一致锁、严格顺序消息、可靠队列或高频协同状态。
2. Durable Object 用于单一实体或协作房间的强一致协调，不作为全局关系数据库。
3. 默认由 PostgreSQL 保存业务事实、Better Auth 及其 Paca 权限插件/Agent Auth 的状态、审计和可查询数据；D1 模式必须通过独立适配器达到相同的领域契约。DO 保存实体级实时状态和短期协调数据。
4. Queues/Workflows 承担需要重试、恢复和可靠执行的后台事件；WebSocket 广播不代表事件已经可靠处理。
5. R2 保存附件、大型快照和归档，不把二进制文件放入 KV 或核心关系数据库。
6. 不长期并存两套 RBAC。迁移完成后，旧 Go `PermissionStore`、`Authorizer`、legacy role 合并和重复权限表必须退出；业务对象归属和状态流转校验属于领域不变量，不是第二套权限系统。

## 二、组件映射

| 当前模块 | Cloudflare 目标组件 | 说明 |
| --- | --- | --- |
| React Web | Workers Static Assets / Pages + TanStack Router/Query/Form | 静态资源、SPA 路由、服务端状态和表单；默认不引入 TanStack Start |
| Go API | Workers + TypeScript + Hono，或迁移期保留 Go API | Hono 是 Worker API 的默认路由与中间件框架，不要求一次性重写全部 API |
| 用户认证与权限 | Better Auth Core + Paca Permission 插件 | Session、真实业务作用域、动态角色与权限的唯一来源 |
| Agent 鉴权 | Better Auth Agent Auth | Agent 身份、注册、审批、Capability Grant、短期 JWT 与审计；不以普通 API Key 代替 |
| PostgreSQL | 任意兼容供应商 + Hyperdrive | 默认核心业务数据库，不绑定云服务商 |
| D1 | D1 Binding + SQLite 方言 ORM | 可选数据库后端，需要独立 schema、迁移和 repository 适配 |
| Socket.IO | PartyServer/PartySocket + Durable Objects | 复用房间路由、重连、广播和 WebSocket Hibernation |
| Valkey Cache | KV、Cache API，必要时 DO Storage | 按一致性要求选择，不能机械替换 |
| Valkey Pub/Sub | DO 广播、Queues、Workflows | 在线推送与可靠事件处理必须分开 |
| Valkey Streams | Queues + Workflows + 幂等消费 | 接受队列至少一次投递语义，消费者必须幂等 |
| 对象存储 | R2 | 附件、导出文件、Yjs 大型 checkpoint 和归档 |
| Agent 控制面与 Harness | Better Auth Agent Auth + Cloudflare Agents SDK / AgentDO + Workflows + Agent Tracing | Cloudflare 托管 Agent 与本地 Codex、Claude Code、DeepSeek 等 Harness 共用任务和授权协议；确需不可信代码执行时再接独立 sandbox |

## 三、数据库、ORM 与 D1 策略

### PostgreSQL 默认路径

PostgreSQL 是默认数据库类型，但不得把火山云、Supabase、Neon、AWS、Azure、GCP 或其他供应商名称写入领域层、repository 接口或迁移逻辑。只要数据库满足以下条件，就可以作为部署后端：

- 能被 Cloudflare Hyperdrive 支持的 PostgreSQL 驱动或协议访问。
- 提供 Worker 可达的安全连接方式，并满足 Hyperdrive 当前的 TLS、版本和网络要求。
- 支持 Paca 实际使用的 PostgreSQL 特性与扩展。
- 连接数、事务、备份、恢复、高可用、地域和数据合规满足部署要求。

供应商相关配置只能出现在部署配置、Secret、运维文档或基础设施代码中。应用只消费 Hyperdrive binding 提供的连接信息。

### ORM 和表结构管理

迁移到 Workers/TypeScript 的数据库代码应优先使用 Drizzle ORM 管理类型化 schema、查询和迁移。Cloudflare 官方同时给出了 Drizzle 连接 Hyperdrive/PostgreSQL 的路径，Drizzle 也支持 D1/SQLite 方言，适合在一个代码库内维护两种明确分离的数据库实现。

要求如下：

- schema 定义和版本化 migration 必须进入版本控制；生产环境禁止依赖运行时自动 `push` 或启动时猜测表结构。
- ORM 生成的 SQL 必须经过代码审查，尤其检查删列、改类型、索引、锁表和数据回填操作。
- PostgreSQL 与 D1 使用不同 SQL 方言时，分别维护 `postgres` 与 `sqlite/d1` schema 和 migrations；不要假设一份生成 SQL 可以安全用于两者。
- Better Auth Core、Paca Permission 插件和 Agent Auth 所需 schema 必须进入同一套版本化迁移流程。可以使用 Better Auth CLI 生成变更草案，但最终迁移仍应由项目 ORM/migration 流程审查和执行，禁止生产启动时自动改表。
- Better Auth 在 PostgreSQL 与 D1 模式下必须共享同一认证授权领域契约；数据库 adapter 可以不同，但不得出现 PostgreSQL 一套角色语义、D1 另一套简化权限的情况。
- 领域服务依赖 repository/port 接口，不直接依赖 Drizzle、`pg`、D1 binding 或供应商 SDK。
- 为两个 adapter 运行同一组 repository contract tests，验证事务、唯一性、分页、排序、权限和并发语义。
- 当前 Go API 继续使用 `sqlx` 和现有 PostgreSQL migrations，直到对应模块迁移到 Worker。不要为了形式上的 ORM 一致性一次性重写已稳定的 Go repository。
- 新 Worker 模块应避免手写散落 SQL；确需使用方言特性时，通过 ORM 的显式 SQL escape hatch，并在代码旁说明为什么无法由 schema/query builder 表达。

Prisma 和 Kysely 也可作为候选，但在选型前必须核对其当时对 Workers、Hyperdrive、D1 driver 和 migration 的成熟度。当前方案优先 Drizzle，是因为 PostgreSQL 与 D1 都有清晰适配路径，而不是要求所有数据库必须共享完全相同的模型文件。

### D1 支持结论

D1 可以用于 Paca，但它是 SQLite 语义的独立数据库后端，不是通过 Hyperdrive 连接的 PostgreSQL，也不能直接执行现有 PostgreSQL migrations。

当前 Paca 的 schema 和 repository 使用了较多 PostgreSQL 特性，包括 UUID/default functions、`JSONB` 及其操作符、GIN/`tsvector` 全文检索、`ILIKE`、显式类型转换、日期区间、`generate_series`、行锁和 `FOR UPDATE`。因此完整 D1 支持意味着建立一个真正的 D1 adapter，而不是只替换连接字符串。

允许三种部署模式：

1. PostgreSQL 模式，默认：Hyperdrive + PostgreSQL adapter，提供完整功能。
2. D1 模式，可选：Worker D1 Binding + SQLite/Drizzle adapter；只有通过功能和并发测试的模块才能声明支持。
3. 混合模式，谨慎使用：PostgreSQL 保存业务事实，D1 仅保存有明确所有权的边缘派生数据、租户隔离数据或可重建索引。禁止对同一业务聚合进行无事务保障的双主写入。

D1 adapter 的实现约束：

- D1 完整模式默认要求访问数据库的 API 已迁移到 Workers/Pages，并通过 D1 binding 访问；不要把 D1 当成现有 Go `database/sql` 的直接替换驱动。
- UUID 在应用层生成并以 `TEXT` 或经过验证的 `BLOB` 表示，不能依赖 PostgreSQL `gen_random_uuid()`。
- JSON 使用 SQLite JSON functions；不能复用 PostgreSQL `JSONB` 操作符和 GIN 索引。
- 全文检索改用 D1 支持的 FTS5，或者交给独立搜索服务；不能复用 `tsvector` 查询。
- 多语句原子写入使用 D1 `batch()` 或经过 ORM 明确支持的事务能力；依赖 `SELECT ... FOR UPDATE` 的流程必须重写。
- 需要跨请求串行化的实体写入可由对应 Durable Object/PartyServer 协调，但仍要用数据库唯一约束和幂等键兜底。
- 启用 D1 read replication 时必须使用 Sessions API 和 bookmark 表达 read-your-writes/顺序一致性需求；所有写入仍由 primary 处理。
- 避免把超大 Yjs checkpoint 或附件存入 D1；继续使用 R2，并在数据库里保存索引和元数据。
- 上线前核对 D1 当时的数据库大小、单行大小、绑定参数、查询时长、迁移和备份限制，本文档不固定容易变化的数值。

D1 比较适合 Cloudflare-only 的轻量部署、按租户分库、可重建的边缘数据和不依赖 PostgreSQL 专有能力的新模块。若要求完整兼容当前 Paca 的搜索、复杂 JSON 筛选和事务行为，优先使用 PostgreSQL；完整切换到 D1 应被视为单独的数据库移植项目。

## 四、目标架构

```text
Browser / React
├── HTTP API ──────────────── Worker API / Hono
│                              ├── Better Auth Core
│                              │    ├── Paca Permission Plugin
│                              │    └── Agent Auth
│                              ├── Hyperdrive ── 任意兼容 PostgreSQL（默认）
│                              ├── D1 Binding ── D1 adapter（可选）
│                              ├── R2
│                              ├── Queues / Workflows
│                              └── Durable Object RPC
│
├── 项目与通知实时事件 ─────── ProjectParty / UserParty
│
└── BlockNote + Yjs ───────── DocumentParty（YServer / DocumentDO）
                               ├── WebSocket Hibernation
                               ├── DO SQLite：Yjs 增量与 checkpoint
                               ├── Queue：异步物化 BlockNote JSON
                               └── R2/业务数据库：长期快照与业务视图

Agent Auth ── Paca Agent Control Plane ── Workflow ──RPC────── DocumentParty
                   ├── Cloudflare Agent + Agent Tracing
                   ├── Local Codex / Claude Code / DeepSeek Harness
                   └── 可选独立 Sandbox（仅不可信代码、构建或 shell 任务）
```

Worker 是公开入口和鉴权边界。任何客户端都不应直接根据一个可猜测的 room ID 获得文档或项目访问权限。

### Worker API 与前端技术栈

迁移后的 Worker API 默认使用 Hono。Better Auth 通过 Web Standard `Request`/`Response` 直接挂载到 Hono，例如 `/api/auth/*`；认证路由必须注册在可能吞掉请求的 catch-all 路由之前。部署到 Workers 时，按当前 Better Auth 官方要求配置对应的 `nodejs_compat` 或更小范围兼容标志，并在升级时重新核对要求。

Hono 中间件统一解析以下两类可信身份上下文：

- 用户请求：Better Auth Session，随后调用 Paca Permission 插件检查 system/organization/project 权限。
- Agent 请求：Better Auth Agent Auth JWT，通过 `getAgentSession()` 或等价官方入口验证签名、`aud`、`exp`、`jti`、有效 Grant 和约束。

React Web 继续采用现有的 TanStack Router、TanStack Query 和 TanStack Form。Router 管理 SPA 路由，Query 管理服务端状态、缓存失效和 mutation，Form 管理复杂表单。Better Auth Client 与 TanStack Query 可以协作，但不要把服务端授权结果只放在前端缓存里；前端权限判断只用于 UI 展示，最终授权始终在 Worker/DocumentParty 执行。

浏览器部署优先让 React Web 与 `/api/*` 处在同一 origin，例如由同一个 Worker 同时提供 Static Assets 与 Hono API。若 Pages 与 API Worker 分开部署，应使用同一站点下的受控自定义域名、精确 CORS allowlist 和 `credentials`，不得依赖 `pages.dev` 到 `workers.dev` 之间的第三方 Cookie。Better Auth Session Cookie 默认保持 `Secure`、`HttpOnly`、`SameSite=Lax`；只有经过明确威胁建模时才允许改为 `SameSite=None`。

### Better Auth 唯一认证授权模型

不要为了适配 Better Auth 内置层级而把 Paca Project 强行映射为 Organization 或 Team：

- Better Auth Organization 只表示 Paca 真实存在的租户、组织或工作区；当前产品若只有单工作区，可以使用一个默认 Organization，但其语义仍不是 Project。
- Better Auth Team 只在 Paca 真正需要组织内团队分组时使用，不把它作为 Project 权限边界。Better Auth 原生 TeamMember 不提供独立的团队角色，无法原生表达“同一用户在项目 A 是管理员、在项目 B 是只读成员”。
- Project、ProjectMember、ProjectRole 和 RolePermission 保持 Paca 真实领域语义，由自定义 `pacaPermission` Better Auth 插件定义 schema、endpoint、middleware 和类型化 client。

`pacaPermission` 是 Better Auth 实例的一部分，而不是并行权限服务。推荐作用域：

```text
system        实例级用户、设置和全局管理权限
organization  真实租户/组织级权限
project       项目成员、任务、文档、Agent、环境和工作流权限
```

角色允许在运行时动态创建和修改，权限词汇必须在代码中静态定义并经过审查。权限使用 resource/action 表达，至少覆盖当前稳定权限的等价能力：

```ts
const statement = {
  users: ["read", "write", "delete"],
  globalRoles: ["read", "write", "assign"],
  projects: ["read", "write", "create", "delete"],
  projectMembers: ["read", "write"],
  projectRoles: ["read", "write"],
  tasks: ["read", "write"],
  sprints: ["read", "write"],
  docs: ["read", "write"],
  agents: ["read", "write", "approveGrant"],
  environments: ["read", "write", "connect"],
  workflows: ["read", "write", "execute"],
  settings: ["write"],
} as const;
```

插件应提供服务端类型安全的权限入口，例如：

```ts
await auth.api.hasProjectPermission({
  headers: request.headers,
  body: {
    projectId,
    permissions: { tasks: ["write"] },
  },
});
```

Hono 路由应通过统一的 `requireProjectPermission()` 等中间件调用该入口，不得各自查询角色表或复制通配符判断。任务是否属于 URL 中的项目、状态是否允许转换、文档是否已删除等检查仍由领域服务负责；这些是数据与业务不变量，不是第二套权限系统。

迁移期间允许旧 Go Authorizer 与 Better Auth 进行短期 shadow read/decision comparison，但不能长期双写或把两者都当权威来源。切换后由 Better Auth 与 `pacaPermission` 独占角色、成员关系和权限判定；旧 Go 权限合并代码与重复 schema 必须删除或由插件正式接管。

### Better Auth Agent Auth

Paca Agent 是一等执行主体，正式 Agent 鉴权必须使用 Better Auth Agent Auth，不得用带 metadata 的普通 API Key 模拟。Agent Auth 负责 Agent/Host 身份、注册、delegated/autonomous 模式、Capability 发现与申请、用户审批、Grant、短期签名 JWT、防重放和审计事件。

必须区分：

- 用户“管理 Agent”的权限属于 Paca Permission，例如 `agents.read`、`agents.write`、`agents.approveGrant`。
- Agent “执行业务”的权限属于 Agent Auth Capability，例如 `project.read`、`task.read`、`task.write`、`task.create`、`task.execute`、`document.edit`、`environment.connect`、`workflow.execute`。

Capability Grant 必须携带最小作用域约束，例如 `organizationId`、`projectId`、`documentId`、`taskIds`、允许的字段或操作模式，不能只授予一个无边界的 `task.write` 或 `task.create`。修改既有工作项时应绑定具体 `taskId` 和字段；创建工作项时至少绑定 Organization、Project、操作模式和短有效期。Hono 自定义 `location` 路由在取得 `agentSession` 后，必须同时检查 active grant 和 constraints；不能因为 JWT 已通过签名验证就跳过约束。

Delegated Agent 的最终权限是 Capability Grant 与被代理用户当前 Paca 权限的交集；用户离开项目、角色被收回或会话被撤销后，Agent 不得继续沿用旧权限。Autonomous Agent 以审批后的 active Grant 和约束为唯一业务授权来源。

普通 Better Auth API Key 仅用于 CI、Webhook、脚本和兼容 API 等非 Agent 集成，不作为 Agent Runner 身份。Agent Auth 当前仍在快速演进，落地时必须锁定版本、隔离适配层、覆盖注册/审批/撤销/JWT/约束测试，并在每次升级前核对官方文档和变更记录。

### Agent 控制面、Tracing 与多 Harness

Paca 的 Agent 控制面不得绑定某一种模型或执行器。每个 Better Auth Agent ID 对应一个稳定命名的 Cloudflare Agents SDK AgentDO；该对象只保存当前/最近 run、状态版本、恢复游标等有界协调状态，不保存 prompt、任务正文、JWT、Grant、数据库凭据或完整模型上下文。PostgreSQL 仍是 Agent、Grant、任务、run、审计和业务结果的权威来源，Workflow 仍是跨步骤重试、等待、取消和恢复的权威编排器。

支持的 Harness 至少包括：

- Cloudflare 托管 Agent：适合持续在线的业务工具调用，使用 Agents SDK 的状态、RPC、durable execution 能力，并由 Cloudflare Agent Tracing 观察 Agent、模型和工具执行。
- 本地 Codex、Claude Code、DeepSeek harness 或其他 Agent Host：使用本机终端、文件系统和模型能力，通过 Better Auth Agent Auth 注册、审批和取得受约束 Grant，再通过 Paca Agent API 领取与提交任务。
- 未来其他远程 Harness：只要实现同一版本化协议和安全约束即可接入，不得绕过 Agent Auth 直接读写业务数据库或 DocumentParty。

所有 Harness 共用以下控制协议和语义：注册与心跳、能力发现与申请、审批、领取任务、短期 lease/续租、幂等 checkpoint、提交结果、取消确认、Grant 撤销和审计。Harness 类型只影响执行能力与调度标签，不改变 `project.read`、`task.write`、`document.edit` 等 Capability 的业务语义。任务分派必须按 Agent/Host 已审批 capability、约束、在线状态和 Harness 能力匹配，不能仅按客户端自报名称决定权限。

领取和推进工作项使用独立的 `task.execute` Capability，不把“可以运行任务”混入 `task.write`。Grant 至少绑定 Organization、Project、Task、`operationMode=execute`、允许的 action 与短有效期；Agent Auth Session 中的 Agent/Host 是可信租约所有者，客户端提交的 actor 字段一律忽略。PostgreSQL 对同一 Task 的 active lease、单调版本、checkpoint 序列、幂等 request ID 和事件记录负责，AgentDO 只镜像有界运行摘要。Harness 若要实际修改 Task 或 Document，仍需另行取得对应 `task.write`、`document.edit` Grant，`task.execute` 本身不授予业务字段写权限。

Cloudflare Agents SDK 的默认 `/agents/*` 路由不得直接公开。浏览器、Cloudflare Agent 和外部 Harness 都先经过 Hono 的 Better Auth Session 或 Agent Auth JWT 校验，再由服务端按 Better Auth Agent ID 获取 AgentDO stub；AgentDO RPC 与 Workflow 在执行敏感工具前仍需重查 active Grant、constraints 和 delegated 用户权限交集。

Agent Tracing 是运行可观测性，不是权限、业务审计或可靠事件日志。生产默认不记录 prompt、文档内容、JWT、Grant、secret 和工具原始 payload；只记录 run ID、Agent ID、Harness 类型、工具名、安全状态码、耗时和关联 span。Tracing 可能采样或丢失，业务审计必须继续写入 PostgreSQL。若后续使用 AI SDK，应采用 Cloudflare 官方 tracing 包装或自定义 span，并保持 payload 脱敏。

当前任务编辑、文档操作和 backlog 拆解均通过受限 Paca 业务工具完成，不要求通用 shell sandbox。本地 Harness 使用其受用户控制的本机执行环境。只有任务明确需要执行不可信代码、隔离构建、原生二进制或远程 shell 时，才在版本化 Execution Gateway 后接入独立 sandbox（Computer、Sandbox SDK 或 Containers），并重新完成当时的可部署性、安全和恢复验收；不得把 preview 实验后端设为当前生产主线。

## 五、PartyKit、PartyServer 与 Durable Objects

PartyKit 已于 2024 年加入 Cloudflare。对于本项目的新 Workers 原生实现，优先采用当前 Cloudflare `cloudflare/partykit` 仓库中的组件，而不是从零实现 WebSocket 房间协议：

- `partyserver`：基于 Durable Objects 的服务端房间抽象，提供生命周期钩子、广播、连接管理和 Hibernation 支持。
- `partysocket`：客户端 WebSocket，提供自动重连、缓冲和连接恢复能力。
- `y-partyserver`：在 PartyServer 上提供 Yjs 服务端和浏览器 Provider。
- `hono-party`：如果 Worker API 使用 Hono，可用于把请求路由到 PartyServer。

这里仍然遵循“一篇文档一个协调对象”。PartyServer 是 Durable Object 上层库，不会消除或额外复制 DO；一个名为 `documentId` 的 PartyServer room 对应一个底层 DO。

推荐默认路线：

```text
BlockNote
  ⇄ Y.Doc
  ⇄ y-partyserver/provider
  ⇄ DocumentParty extends YServer
  ⇄ Durable Object + SQLite Storage
```

只有出现以下情况时才直接编写底层 DocumentDO 协议：

- `y-partyserver` 无法表达所需的鉴权或二进制协议。
- 需要对 update log、checkpoint 或消息计费做高度定制。
- 压测证明 PartyServer 抽象产生了不可接受的性能问题。
- 所需功能依赖尚未稳定的 PartyServer API，且自行实现风险更低。

PartyServer/PartyKit 不能替代核心业务数据库、Queues、Workflows、R2 或 Better Auth/Paca Permission/Agent Auth。它只简化实时房间、WebSocket 和 Yjs Provider。

依赖这些库前必须检查当前版本、官方 README、变更日志和已知问题。PartyServer 仍在持续演进，Worker 与 DO 间的接口要保持向前、向后兼容，避免滚动发布期间版本短暂不一致造成错误。

## 六、Durable Object 的划分

### DocumentParty / DocumentDO

采用“一篇文档一个 PartyServer room/DocumentDO”。使用 PartyServer 时优先通过基于名称的路由访问：

```ts
const stub = await getServerByName(env.DOCUMENTS, documentId);
```

不要用 `newUniqueId()` 表示文档房间；文档必须可由稳定的 `documentId` 再次寻址。路由层也可以使用 `routePartykitRequest()`。

这不会让所有文档都变成常驻实例。DO 按请求惰性激活，空闲后可以退出内存；逻辑对象总数不是主要成本，主要成本来自活跃请求、消息、运行时长和实际存储。

DocumentParty/DocumentDO 负责：

- 文档连接鉴权和当前连接管理。
- Yjs update 同步与广播。
- Awareness、光标、选区等临时状态。
- Agent 与用户并发写入的串行协调。
- Yjs checkpoint、增量更新和恢复。
- 将持久化或物化工作投递到 Queue。

必须启用 PartyServer 的 Hibernation，或在自定义 DO 中直接使用 WebSocket Hibernation API。不要使用会让实例持续计费的普通 WebSocket `accept()` 模式；不要用 `setInterval`、长时间定时器或持续的出站 TCP/WebSocket 连接阻止休眠。

DO 休眠会丢失内存中的 `Y.Doc`，因此重要状态不能只存在内存。WebSocket 身份信息应放入 attachment，可恢复文档状态应放入 DO SQLite、R2 或所选业务数据库。

### ProjectParty、UserParty 与对应 DO

- ProjectParty：项目范围的 `task.*`、`doc.*`、`workflow.*`、`sprint.*` 在线广播和短期协调。
- UserParty：个人通知、私有 Agent 对话流和用户级连接管理。
- 需要可靠消费的事件仍先进入 Queue/Workflow，再由 DO 推送结果；不要把在线广播当作消息队列。

不要为了减少 DO 数量把所有文档合并进一个 ProjectParty。这样会制造单对象热点、扩大故障影响，并让文档状态恢复和权限控制更复杂。

## 七、Yjs 与 BlockNote

Yjs 是协作状态和冲突合并层，不是鉴权、审计或业务数据库。Paca 使用 BlockNote，优先采用 BlockNote 官方的 Yjs 协作接口。

默认使用 `y-partyserver/provider` 连接浏览器中的 Y.Doc，并让文档房间继承 `YServer`。`y-partyserver` 已处理 Yjs 同步协议和 Awareness，不要在没有明确必要时自行实现完整 Yjs wire protocol。

`YServer` 默认只保证有客户端连接期间的内存副本。必须实现 `onLoad` 和 `onSave`，或采用经过验证的等价持久化钩子；不能因为使用 PartyKit/PartyServer 就省略持久化。保存回调需要 debounce/max-wait，避免按键级写入。

推荐的数据路径：

```text
BlockNote blocks ⇄ Y.Doc
                     ├── 增量 update：DO SQLite
                     ├── 合并 checkpoint：DO SQLite 或 R2
                     └── 可查询 BlockNote JSON：异步物化到业务数据库
```

实现要求：

- 不要每次按键都覆盖业务数据库中的完整 BlockNote JSON。
- 在客户端和服务端合并短时间内产生的 Yjs updates，避免每个逻辑操作产生一次存储写入。
- 达到时间、数量或大小阈值后生成 checkpoint，并清理已经被 checkpoint 覆盖的旧 updates。
- 文档空闲或重要操作完成时执行最终 flush。
- 业务数据库中保留标题、权限、创建者、更新时间、检索字段、业务快照和可查询的 BlockNote JSON。
- 不要在协作开始后仅用业务数据库中的 blocks 创建一个全新的 Y.Doc；恢复时必须保留 Yjs 文档状态，否则会丢失协作历史。

Yjs Awareness 只表示临时在线状态，不持久化。它可以替代“谁正在编辑”、光标和选区，但不能替代登录会话、权限记录或审计日志。

## 八、用户与 Agent 编辑文档

同一篇文档无论由一个用户、一个 Agent，还是 Agent 与用户同时使用，都只对应同一个 DocumentParty/DocumentDO。区别是连接与冲突处理，而不是 DO 数量。

### 仅用户编辑

- Worker 先通过 Better Auth Session 和 `pacaPermission` 验证 `docs.read`/`docs.write`，再向 DocumentParty 建立连接。
- 浏览器通过 WebSocket 发送小粒度 Yjs updates。
- DocumentParty 负责同步、Awareness、checkpoint 和断线恢复。
- 空闲连接使用 Hibernation，避免无消息时持续产生运行时费用。

### 仅 Agent 编辑

Agent 推理不能在 DocumentParty 内长时间运行。推荐流程：

1. Agent 通过 Better Auth Agent Auth 获取并使用受约束的 active Capability Grant。
2. AgentDO 或 Workflow 在验证 `document.read` Grant 及其 `projectId`/`documentId` constraints 后，从 DocumentParty 获取快照和 Yjs state vector。
3. 在已注册的 Cloudflare 托管 Agent 或本地 Harness 中完成推理，并只通过受约束的 Paca 业务工具执行修改；确需不可信代码时再调用独立 sandbox Gateway。
4. 以 Agent Auth JWT 和 RPC/HTTP 向 DocumentParty 提交结构化修改。
5. DocumentParty 验证 `document.edit` Grant、constraints、版本和目标范围后应用修改并持久化。

推理期间 DocumentParty 可以休眠。即使没有用户在线，Agent 也应经过 DocumentParty 写入，不能绕过实时状态直接修改业务数据库。

### Agent 与用户同时编辑

DO 会依次处理收到的事件，Yjs 负责合并 CRDT 操作。但 Yjs 只能避免数据层面的简单覆盖，不能判断双方的业务意图是否冲突。

- 用户修改段落 A、Agent 修改段落 B：通常可以自动合并。
- 用户和 Agent 同时修改同一句话：最终 CRDT 状态合法，但语义可能不正确。
- Agent 基于旧快照提交整篇替换：可能删除用户的新内容，禁止这样实现。

Agent 必须提交细粒度、可验证的操作，例如：

```json
{
  "actorType": "agent",
  "actorId": "agent-123",
  "runId": "run-456",
  "baseStateVector": "...",
  "operations": [
    {
      "type": "replace_block_content",
      "blockId": "block-abc",
      "expectedVersion": 12,
      "content": "..."
    }
  ]
}
```

DocumentParty 应当：

1. 从已验证的 Better Auth Session 或 Agent Auth `agentSession` 确定 actor，不信任客户端自行声明的身份。
2. 比较 state vector、目标 block 版本或作用域版本。
3. 未发生相关修改时，在一次 Yjs transaction 中应用操作。
4. 目标范围已经变化时，让 Agent 重新读取和规划，或转为用户确认的建议。
5. 将 `actorType`、`actorId`、`runId`、目标范围和结果写入业务数据库审计记录。
6. 将已应用的变更广播给在线客户端。

不要仅依赖 Yjs transaction 的本地 `origin` 做审计；应由 DocumentParty 给每次更新增加服务端可信信封。

建议提供三种 Agent 编辑模式：

- 建议模式，默认：生成 diff、评论或建议，由用户接受。
- 协作模式：Agent 可以直接修改指定 block，并在 UI 中展示 Agent 状态。
- 独占模式：大规模重写时申请短期文档或 block lease，结束后向用户展示 diff。

## 九、权限、安全与一致性

- Better Auth Core、`pacaPermission` 与 Agent Auth 共同构成唯一认证授权体系；不得在 Hono、DO 或 Workflow 中重新实现一套角色表和权限聚合器。
- Worker 在创建或转发 DO 请求前区分用户 Session 与 Agent Auth JWT。用户请求检查 Paca 项目权限；Agent 请求检查 active Capability Grant 及其 constraints。
- DocumentParty 在建立连接和执行敏感 RPC 时再次检查文档级权限、Grant/constraints 或权限版本。高频 Yjs update 可以使用短期、绑定 actor/project/document/action/expiry/nonce 的连接 capability，避免每次更新访问关系数据库。
- room 名称、document ID 或传输层加密都不能替代业务授权。
- 使用短期 capability/token 时，要绑定 actor 类型、actor ID、Organization、Project、Document、操作范围、过期时间和 nonce；角色、Grant 或成员关系变更时必须能通过版本号、撤销或强制重连使旧 capability 失效。
- Agent 使用 Agent Auth 独立身份和最小 Capability Grant，不复用用户浏览器凭据，也不使用普通 API Key 冒充 Agent 身份。
- Delegated Agent 每次敏感操作都应确保 Grant 与被代理用户当前权限仍有交集；Autonomous Agent 只依赖审批后仍为 active 的 Grant 与 constraints。
- 所有可重试的 Queue/Workflow handler 必须幂等，并记录业务幂等键。
- PostgreSQL 模式下，PostgreSQL 是任务、成员、Better Auth/Paca Permission/Agent Auth 状态、审计和业务快照的权威来源；D1 模式下由通过契约测试的 D1 adapter 承担同一职责。
- DO 是文档协作期间的权威协调入口；禁止 API、Agent 和后台任务分别维护互不知情的写路径。

## 十、性能与成本约束

- 关注“同时活跃文档数”，而不是数据库里的文档总数。
- 关注每篇文档的消息频率和单个热门文档，而不是提前合并 DO。
- 对 Yjs update 做 20–200 ms 级别的批处理，具体值通过压测确定。
- 对光标和 Awareness 事件节流；不要求每个鼠标事件都持久化或广播。
- WebSocket frame 可以承载多个逻辑 update，降低消息和上下文切换数量。
- PostgreSQL 模式下，不在 DocumentParty 中保留长期出站连接；D1 模式通过 binding 访问。两种模式都优先通过短请求或 Queue/Worker 异步物化。
- 监控 DO 请求数、活跃时长、休眠命中、SQLite 行读写、单文档消息速率、checkpoint 大小和恢复耗时。

## 十一、工程实施治理

- 根目录 `TODO.md` 是工程进度的唯一清单，记录阶段、依赖、当前代码落点、验收条件和完成状态。
- 本文档只维护目标架构、技术选型和不可违反的约束。实现发现架构假设错误时，先更新本文档并记录原因，再调整 `TODO.md`。
- 每个阶段开始前必须在 `TODO.md` 写明最小交付物、验证命令和回滚路径；完成后只有在验收条件全部通过时才能勾选。
- 禁止为了让进度看起来完成而降低权限、数据一致性、审计、并发或恢复要求。实验性 D1 路线不得阻塞默认 PostgreSQL 路线。
- 迁移期间允许短期双读、shadow decision 和可回滚流量切换；禁止没有退出条件的长期双写和双权威来源。

## 十二、官方参考

- Cloudflare Durable Objects：https://developers.cloudflare.com/durable-objects/
- Cloudflare 收购 PartyKit 的说明：https://blog.cloudflare.com/cloudflare-acquires-partykit/
- Cloudflare PartyServer：https://github.com/cloudflare/partykit/tree/main/packages/partyserver
- Cloudflare Y-PartyServer：https://github.com/cloudflare/partykit/tree/main/packages/y-partyserver
- Durable Objects WebSocket Hibernation：https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- Durable Objects 限制：https://developers.cloudflare.com/durable-objects/platform/limits/
- Durable Objects 计费：https://developers.cloudflare.com/durable-objects/platform/pricing/
- Cloudflare Hyperdrive：https://developers.cloudflare.com/hyperdrive/
- Hyperdrive 支持的数据库与特性：https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/
- Hyperdrive + PostgreSQL + Drizzle：https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/drizzle-orm/
- Cloudflare D1：https://developers.cloudflare.com/d1/
- D1 SQL/SQLite 兼容性：https://developers.cloudflare.com/d1/sql-api/sql-statements/
- D1 ORM 和 query builder 生态：https://developers.cloudflare.com/d1/reference/community-projects/
- D1 migrations：https://developers.cloudflare.com/d1/reference/migrations/
- D1 与 PostgreSQL/MySQL 导入差异：https://developers.cloudflare.com/d1/best-practices/import-export-data/
- D1 Sessions 与 read replication：https://developers.cloudflare.com/d1/best-practices/read-replication/
- D1 Worker Binding 与原子 batch：https://developers.cloudflare.com/d1/worker-api/d1-database/
- D1 平台限制：https://developers.cloudflare.com/d1/platform/limits/
- Cloudflare Queues：https://developers.cloudflare.com/queues/
- Cloudflare Workflows：https://developers.cloudflare.com/workflows/
- Cloudflare R2：https://developers.cloudflare.com/r2/
- Cloudflare Agents SDK：https://developers.cloudflare.com/agents/
- 在现有 Worker 中加入 Agents SDK：https://developers.cloudflare.com/agents/getting-started/add-to-existing-project/
- Cloudflare Agent Tracing：https://developers.cloudflare.com/agents/runtime/operations/observability/tracing/
- Cloudflare Agent Durable Execution：https://developers.cloudflare.com/agents/runtime/execution/durable-execution/
- Better Auth Hono Integration：https://better-auth.com/docs/beta/integrations/hono
- Better Auth Database：https://better-auth.com/docs/concepts/database
- Better Auth Custom Plugins：https://better-auth.com/docs/beta/concepts/plugins
- Better Auth Organization 与 Teams：https://better-auth.com/docs/plugins/organization
- Better Auth Agent Auth：https://better-auth.com/docs/plugins/agent-auth
- TanStack Router：https://tanstack.com/router/latest
- TanStack Query：https://tanstack.com/query/latest
- TanStack Form：https://tanstack.com/form/latest
- BlockNote 协作编辑：https://www.blocknotejs.org/docs/features/collaboration
- BlockNote Yjs Utilities：https://www.blocknotejs.org/docs/reference/editor/yjs-utilities
- Yjs Awareness：https://docs.yjs.dev/getting-started/adding-awareness
