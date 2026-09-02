# Cloudflare API 迁移清单

本文档是根 `AGENTS.md` 目标架构在 API 切换阶段的执行视图。运行时可判定的未迁移边界维护在 `services/worker-api/src/migration/manifest.ts`；两者发生冲突时，应先修正代码清单和测试，再同步本文档与根 `TODO.md`。

## 路由与错误契约

- 同源入口 `paca.howlearnwood.com` 的 `/api/auth/*`、已迁移 `/api/v1/*`、`/.well-known/*`、`/ws/*` 和 `/internal/*` 由 Worker 处理。
- 已知但仍由 Go API/容器拥有的领域，在 Worker 上不做隐式转发。Better Auth Session 与旧 Go 身份尚无经过验证的 principal bridge，直接转发会产生第二套授权权威。
- 命中已知未迁移前缀但没有 Worker 路由时，返回 HTTP 501、`code=API_DOMAIN_NOT_MIGRATED`、稳定的 `domain`、`requestId` 和 `x-paca-api-migration-domain`；响应禁止缓存。
- 真正未知的路径继续返回 HTTP 404、`code=NOT_FOUND`。认证、授权、输入、冲突和领域错误继续使用现有统一 envelope。
- 迁移期不从 Worker 自动 fallback 到 Go API。当前回滚单位是已验证的 Worker 版本；使用 README 中固定版本回滚命令，且不能通过前端重试绕过授权边界。

## 领域清单与依赖图

| 领域 | 当前所有者/权威 | 状态 | 后续依赖 |
| --- | --- | --- | --- |
| Better Auth 用户 Session | Worker / PostgreSQL | Worker 原生 | 旧用户 ID/Account/Session 迁移策略与拒绝用例补齐 |
| Organization、Project Permission、系统角色 | Worker / PostgreSQL | Worker 原生 | 旧 Authorizer shadow comparison、最终删除重复 RBAC |
| Project、成员、角色 | Worker / PostgreSQL | Worker 原生 | 新旧 contract/data comparison |
| Task、Activity、父子/关联、附件 | Worker / PostgreSQL + R2 | Worker 原生 | 新旧 contract/data comparison |
| Sprint、View、Custom Field、任务位置 | Worker / PostgreSQL | Worker 原生 | 真实登录浏览器 E2E |
| Document、Yjs、实时协作 | Worker / PostgreSQL + DO + Queue + R2 | Worker 原生 | BlockNote 浏览器恢复证据与并发压测 |
| Agent Auth、Grant、Host、Task Harness | Worker / PostgreSQL + AgentDO | Worker 原生 | autonomous 总验收、旧 Runner 身份迁移 |
| Document Agent Workflow | Worker / Workflow + AgentDO + DocumentParty | Worker 原生 | 远端 Document E2E 与更多领域执行器 |
| Notification | Worker 空投影 | Bridge | repository、UserParty 可靠推送与已读写入 |
| Plugin 列表 | Worker 空投影 | Bridge | 插件运行时隔离、安装和权限模型 |
| Paca Agent CRUD、Conversation、Skill、Env Var、MCP Key | Go API | 容器保留 | repository/API 迁移、Conversation 协议与 Runner 身份切换 |
| Static Environment、Terminal、SSH、Port Forward | Go API + agent-runner | 容器保留 | `paca_project` scope adapter、`environment.connect` 执行器、版本化 Execution Gateway |
| Automation、Webhook | Go API + Valkey worker | 容器保留 | repository 迁移、Queue/Workflow 事件与幂等契约 |

```text
Better Auth Session / Agent Auth
        │
        ├── Paca Permission ── Project/Task/Document/Iteration（Worker 原生）
        │
        ├── Agent Grant ────── Task Harness/Document Workflow（Worker 原生）
        │                            │
        │                            └── Environment Gateway（待实现）
        │
        └── Principal Bridge（尚未实现，故禁止隐式代理）
                                     │
                                     └── Go Agent/Environment/Automation（容器保留）
```

## 模块迁移准入

一个领域从 `container-retained` 或 `bridge` 改成 `worker-native` 前，必须同时满足：

1. repository 与数据库权威来源明确，不能让新旧服务同时主写同一聚合。
2. 用户使用 Better Auth Session + Paca Permission；Agent 使用 Agent Auth active Grant + constraints。
3. 新旧 API contract、错误码、分页/排序和数据一致性测试通过。
4. Queue/Workflow 消费者具备业务幂等键；实时广播不能代替可靠处理。
5. 前端只在对应 Worker API 可用后开放入口，权限判断只影响 UI，最终授权仍在服务端。
6. `migration/manifest.ts`、本清单、`TODO.md`、部署烟测和回滚记录在同一变更节点更新。
