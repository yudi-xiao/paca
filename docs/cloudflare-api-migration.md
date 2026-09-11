# Cloudflare API 迁移清单

本文档是根 `AGENTS.md` 目标架构在 API 切换阶段的执行视图。运行时可判定的未迁移边界维护在 `services/worker-api/src/migration/manifest.ts`；两者发生冲突时，应先修正代码清单和测试，再同步本文档与根 `TODO.md`。

本项目未上线，所有新环境从空数据库和空对象存储初始化。这里的“迁移”只表示代码与路由所有权转移，不表示 legacy 数据搬运；不建立用户、Session、权限、附件或业务数据的兼容/双写链路。

## 路由与错误契约

- 同源入口 `paca.howlearnwood.com` 的 `/api/auth/*`、已迁移 `/api/v1/*`、`/.well-known/*`、`/ws/*` 和 `/internal/*` 由 Worker 处理。
- 已知但仍由 Go API/容器拥有的领域，在 Worker 上不做隐式转发。新 Worker 不建立 Better Auth Session 到旧 Go 身份的 principal bridge，避免产生第二套授权权威。
- 命中已知未迁移前缀但没有 Worker 路由时，返回 HTTP 501、`code=API_DOMAIN_NOT_MIGRATED`、稳定的 `domain`、`requestId` 和 `x-paca-api-migration-domain`；响应禁止缓存。
- 真正未知的路径继续返回 HTTP 404、`code=NOT_FOUND`。认证、授权、输入、冲突和领域错误继续使用现有统一 envelope。
- 迁移期不从 Worker 自动 fallback 到 Go API。当前回滚单位是已验证的 Worker 版本；使用 README 中固定版本回滚命令，且不能通过前端重试绕过授权边界。

## 领域清单与依赖图

| 领域 | 当前所有者/权威 | 状态 | 后续依赖 |
| --- | --- | --- | --- |
| Better Auth 用户 Session | Worker / PostgreSQL | Worker 原生 | clean-slate 重建，不迁移旧 User/Account/Session |
| Organization、Project Permission、系统角色 | Worker / PostgreSQL | Worker 原生 | 共享 shadow corpus 已通过；剩余路由迁移后删除旧 Authorizer 和重复 RBAC |
| Project、成员、角色 | Worker / PostgreSQL | Worker 原生 | API contract 回归；不迁移旧业务数据 |
| Task、Activity、父子/关联、附件 | Worker / PostgreSQL + R2 | Worker 原生 | API contract 回归；不迁移旧任务或附件数据 |
| Sprint、View、Custom Field、任务位置 | Worker / PostgreSQL | Worker 原生 | 真实登录浏览器 E2E |
| Document、Yjs、实时协作 | Worker / PostgreSQL + DO + Queue + R2 | Worker 原生 | BlockNote 浏览器恢复证据与并发压测 |
| Agent Auth、Grant、Host、Task Harness | Worker / PostgreSQL + AgentDO | Worker 原生 | autonomous 总验收、Runner 使用新身份重新注册 |
| Project Agent 只读目录 | Worker / PostgreSQL | Worker 原生 | Agent Auth 身份与精确 Project Grant 历史；不返回 secret/完整 constraints |
| Document Agent Workflow | Worker / Workflow + AgentDO + DocumentParty | Worker 原生 | 远端 Document E2E 与更多领域执行器 |
| Notification | Worker / PostgreSQL + Queue + UserParty | Worker 原生 | 分配任务与结构化 `teamMention` 评论在业务事务内写通知和 realtime outbox；列表按当前项目成员关系过滤，已读写入按可信 Session 用户隔离 |
| Plugin 列表 | Worker 空投影 | Bridge | 插件运行时隔离、安装和权限模型 |
| Legacy Paca Agent 写入、Conversation、Skill、Env Var、MCP Key | Go API | 容器保留 | 在 Worker 中重建 Agent Auth 身份扩展、Conversation 协议与 Runner 身份；不得恢复平行 Agent 身份或搬运旧数据 |
| Static Environment、Terminal、SSH、Port Forward | Worker/PostgreSQL + Environment Gateway；旧连接能力仍在 Go API + agent-runner | 部分 Worker 原生 / 容器保留 | 环境列表、创建、详情、重命名、软归档已迁移，Sandbox 按需启动；精确环境/Project/Grant 撤销栅栏已部署。浏览器终端、文件、SSH、Port Forward 仍待重建，旧环境数据直接舍弃 |
| Automation、Webhook | Go API + Valkey worker | 容器保留 | repository 迁移、Queue/Workflow 事件与幂等契约 |

```text
Better Auth Session / Agent Auth
        │
        ├── Paca Permission ── Project/Task/Document/Iteration（Worker 原生）
        │
        ├── Agent Grant ────── Task Harness/Document Workflow（Worker 原生）
        │                            │
        │                            └── Environment CRUD + Gateway（Sandbox provider/私有绑定已部署）
        │
        └── Go Agent/Environment/Automation（仅作待替换的行为基线，不接入新身份或数据）
```

## 模块迁移准入

一个领域从 `container-retained` 或 `bridge` 改成 `worker-native` 前，必须同时满足：

1. repository 与数据库权威来源明确，不能让新旧服务同时主写同一聚合。
2. 用户使用 Better Auth Session + Paca Permission；Agent 使用 Agent Auth active Grant + constraints。
3. 新旧 API contract、错误码、分页/排序等仍需保留的产品行为通过回归；clean-slate 模式不要求旧数据迁移或双写一致性。
4. Queue/Workflow 消费者具备业务幂等键；实时广播不能代替可靠处理。
5. 前端只在对应 Worker API 可用后开放入口，权限判断只影响 UI，最终授权仍在服务端。
6. `migration/manifest.ts`、本清单、`TODO.md`、部署烟测和回滚记录在同一变更节点更新。
