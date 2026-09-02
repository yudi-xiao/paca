# Paca Cloudflare 重构工程进度

本文件是 Cloudflare 重构的唯一工程进度清单。目标架构、技术选型和不可违反的约束以根目录 [`AGENTS.md`](./AGENTS.md) 为准；本文件不重复论证架构，只记录实施顺序、代码落点、验收条件和状态。

## 使用规则

- `[ ]` 未完成；`[x]` 已完成且通过对应验收。
- 一项任务只有在代码、测试、迁移和必要文档同时完成后才能勾选。
- 每个阶段必须保留明确回滚路径；没有回滚方案时不得切换生产流量。
- 数据库迁移、远端部署、Secret 修改和删除旧服务属于外部状态变更，执行前必须确认目标环境。
- 不在日志、提交、Issue 或本文件中记录 `DATABASE_URL`、Better Auth Secret、Agent 私钥或其他凭据。
- PostgreSQL 是默认主线；D1 是独立实验路线，不得阻塞默认主线。

## 当前状态

更新时间：2026-09-02

当前里程碑：**M9 的运行时无关任务 lease 与发现链路已部署为 internal Worker `3ba67ac6-8a13-49ca-9425-858fa1b3b76b`。Better Auth Agent Auth 提供真实 `task.execute` Capability，所有 Harness 都经同一 Agent Auth 边界和 delegated 用户当前 `tasks.read` 权限交集；PostgreSQL 0018 的 lease/event 两张权威表强制单 Task 单 active lease、单调版本/checkpoint、全局 request ID 幂等和可信 Agent/Host owner。`GET /api/v1/agent/tasks/claimable` 仅从 Agent JWT 限定后的精确 active Grant 生成最多 100 个候选，隐藏竞争 lease，并把当前 Agent 的 live lease 返回为可恢复任务。真实本地 Codex Harness smoke lease `52ba8f01-cc57-463a-8b16-741a6a7f7d62` 已通过发现 claimable、领取后发现 owned、续租、checkpoint、完成、重复复用、变更重试/竞争/跳号拒绝和 Grant 撤销。Cloudflare Agent、Codex、Claude Code、DeepSeek 共用执行 contract tests；运行时无关客户端、任务发现 CLI 与 stdin JSON lease CLI 已可供不同本机 Harness 接入。下一步补 Host 心跳/受审批能力标签与匹配、Cloudflare 托管 adapter、租约到期重领与失联/人工取消恢复。`@cloudflare/computer` 仍不在生产主线。当前质量门为 52 个文件/272 项单元测试、4 个文件/21 项 Workers Runtime 测试、TypeScript、Biome、Drizzle、Wrangler dry-run、真实部署和远端 Harness smoke。安全回滚点为上一已验收 Worker `e45b9460-2435-4460-8c29-6178ea7d1caf` / Git `60c5209c`；数据库 0018 为向前兼容的新增表 migration，旧 Worker 不访问新表。**

已确认前置条件：

- [x] 根目录 `AGENTS.md` 已整理为 Cloudflare 目标架构总控。
- [x] 已在 Cloudflare 创建连接 PlanetScale PostgreSQL 的 Hyperdrive 配置，并获得 `HYPERDRIVE` binding ID。
- [x] 根目录 `.env` 已由用户配置 `DATABASE_URL`，用于 Drizzle Kit 和受控的迁移工具。
- [x] `.env` 已被 `.gitignore` 忽略。
- [ ] 根 `DATABASE_URL` 的目标仍对应原 Hyperdrive 的 PlanetScale `paca/main` role，但当前直连认证返回 SASL authentication failed；迁移继续使用受控的临时 admin shell，执行 Drizzle/数据库烟测前必须刷新该 URL，且不得记录凭据。
- [x] 已建立 `services/worker-api`、Wrangler internal 环境和 PR 质量流水线。
- [x] internal Worker 已部署并固定使用自定义入口域名 `paca.howlearnwood.com`，并完成真实 Hyperdrive 查询。
- [x] 预览实例所有权已从早期自动烟测账号转移到用户的真实测试账号；目标账号已验证为 `SUPER_ADMIN / OWNER`，烟测账号已降为 `USER / MEMBER`，从而恢复 `projects.create` 的前端入口与服务端授权。
- [x] 已使用管理页生成的一次性 token 将本机 `Mac codex agent` 注册为 active delegated Agent Host；Host 使用设备本地 Ed25519 身份，私钥仅保存于被 Git 忽略且权限为 `0600` 的 `.paca/agent-host.json`，token 未落盘。该状态只代表 Host 身份已建立，尚未注册 Agent、完成 device approval、取得 Capability Grant 或接入 legacy Agent Runner。
- [x] 已创建隔离的 PlanetScale PostgreSQL `paca/internal` development branch；确认初始 `public` schema 为 0 张业务表。
- [x] 用户确认当前环境尚未上线，授权首个 internal 认证预览直接使用原 `paca/main` Hyperdrive；此例外不代表生产架构决策。
- [x] internal 已退出原 Hyperdrive 的宽权限 role：新建无继承管理角色的 `paca-worker-internal`，现仅显式授予 41 张 runtime 业务表 CRUD，验证其能读取业务表且不能读取 migration ledger；独立 Hyperdrive 已创建并接收 internal 流量。根/main Hyperdrive 仅保留为独立环境与 Wrangler 版本回滚路径。
- [x] 已固化 runtime role 的显式 41 表 CRUD GRANT 与验权 SQL；目标最小权限 role 无 DDL 和 migration ledger/附件迁移账本权限，PlanetScale 授权时使用去掉路由后缀的真实 role 名。现有宽权限 role 的验权会按预期失败，不能作为生产验收结果。
- [x] `deploy:internal` 强制拒绝与根环境相同的 Hyperdrive；首轮 main 预览例外已移除，不能再通过环境变量绕过隔离守卫。
- [x] 已创建 `paca-attachments-development`、`paca-attachments-internal` 与 `paca-attachments-production` 三个隔离 R2 bucket；根/internal Wrangler binding 已分别指向 development/internal，部署守卫会同时拒绝数据库和附件 bucket 环境混用。production binding 待生产环境配置时接入。
- [x] 已实现并实际执行受确认串保护的 `database:provision:internal`：检查 main/internal migration ledger、拒绝分叉目标、以单事务和 `ON CONFLICT DO NOTHING` 初始复制、核对应用表行数与业务表指纹、应用/验证最小权限 role 并创建或更新独立 Hyperdrive；当前清单为 41 张 runtime 表。脚本不输出密码，临时 admin role 15 分钟自动过期；2026-08-31 已完成获批的数据复制与 runtime role 凭据轮换，Task 自引用外键在提交前恢复为 `NOT DEFERRABLE`。
- [x] internal 数据隔离版本 `9ec5c792-3d28-4a5b-8f90-73c9e2a39613` 已部署到 `paca.howlearnwood.com`：Wrangler dry-run/部署输出均确认独立 Hyperdrive 与 `paca-attachments-internal` binding；公开 health 返回 `environment=internal`，真实账号 API 验证完成登录、Session、Demo 项目、12 个任务、登出和旧 Cookie 撤销。
- [x] 已用只读查询确认此前因 `pscale sql` 间歇性 `EOF` 中断的事务未留下部分 DDL；随后改用 `pscale shell` + `psql` 在单事务中成功应用首版 migration。
- [x] `paca/internal` 已生成 13 张表，`paca_schema_migration` 中的 migration ID 与 snapshot checksum 均已核验。
- [x] 经用户明确授权，`paca/main` 已在单事务中应用同一 migration；13 张表及 migration ID/checksum 已核验。
- [x] 0001 Paca Permission migration 先在 `paca/internal` 捕获并修复复合唯一约束顺序问题，再以 2 用户/2 Session 合成数据完成 13→19 表升级演练；临时 PS-10 分支已删除。随后 `main` 在单事务中升级到 19 表，3 个既有用户与 2 个 Session 数量不变，角色/Organization 回填和 snapshot checksum 均已核验。
- [x] 0002 项目投影 migration 已先后应用于 `paca/internal` 与 `paca/main`：新增 `task_id_prefix`、`is_public`、`settings` 和 Organization 内大小写无关项目名唯一索引；两端 migration checksum/索引均已核验，main 的 3 个用户、2 个 Session 未变化。
- [x] 0003 项目角色唯一索引 migration 已先后应用于 `paca/internal` 与 `paca/main`：角色名约束改为 Project 内大小写无关；两端 checksum 与 `(project_id, lower(name))` 索引均已核验，main 仍为 3 个用户、2 个 Session、0 个项目。
- [x] 0004 Organization 角色唯一索引与权限种子 migration 已先后应用于 `paca/internal` 与 `paca/main`：角色名约束改为 Organization 内大小写无关，OWNER 获得 Organization 成员/角色管理权限，MEMBER 获得只读权限；两端 checksum、索引和 4 条权限种子均已核验，main 仍为 3 个用户、2 个 Session、0 个项目。
- [x] 0005 Task 基础 migration 已先后以单事务应用于 `paca/internal` 与 `paca/main`：新增 Task Type、Task Status、项目任务编号计数器、Task 与多 Assignee 共 5 张表，并为既有 active Project 补默认工作流；两端 migration checksum 和表结构已核验，main 仍为 3 个用户、2 个 Session、0 个项目，未产生测试任务数据。
- [x] 0006 Task Activity migration 已先后以单事务应用于 `paca/internal` 与 `paca/main`：新增任务动态/评论表、Task/Project 复合外键、Better Auth 用户与项目成员 actor 关联和查询索引；两端 migration checksum、3 个外键和空数据状态均已核验。现有 Hyperdrive 实际数据库 role 已取得新表 CRUD，main 仍为 3 个用户、2 个 Session、0 个任务。
- [x] 0007 Sprint/View/Custom Field migration 已先后以单事务应用于 `paca/internal` 与 `paca/main`：新增 Sprint、自定义字段定义、任务视图、手工视图位置 4 张表，并为 Task 增加 Project 作用域内 Sprint 外键；迁移使用 PostgreSQL 部分 `ON DELETE SET NULL (sprint_id)`，删除 Sprint 时保留必填 `project_id`。两端 checksum、29 张总表、外键定义均已核验，main 迁移前后保持 0 个 active Project、0 个 active Task；现有 Hyperdrive role 对 4 张新表 CRUD 验权通过。
- [x] 0008 Agent Auth migration 已先后以单事务应用于 `paca/internal` 与 `paca/main`：新增 Agent、Host、Capability Grant、Approval、Better Auth secondary storage 和 Agent 审计 6 张表；两端 checksum、35 张总表和空 Agent 数据状态已核验，main 原有 3 个用户与 2 个 Session 保持不变。
- [x] 0009 Task Activity actor migration 已先后以单事务应用于 `paca/internal` 与 `paca/main`：新增不可变 `actor_type`/`actor_id`、可空 Agent 外键、用户/Agent/System 身份约束与 actor 查询索引；历史行按已有 User 或 System 安全回填，两端 snapshot checksum、非空列、外键和 0 条无效 actor 行均已核验。
- [x] 0010 R2 附件元数据 migration 已先后以单事务应用于 `paca/internal` 与 `paca/main`：新增 `paca_file` 与 `paca_task_attachment`，两端 checksum 一致、32/32 约束有效且初始数据为空；最小权限 runtime role 的 GRANT/验权清单同步扩展到 36 张应用表。
- [x] 0011 附件删除保留期 migration 已先后以单事务应用于 `paca/internal` 与 `paca/main`：新增附件 `purge_after`、附件/文件 `purge_started_at`、到期索引和 active/deleted 状态约束；迁移先回填既有软删除记录再建立约束，两端 snapshot checksum 一致。
- [x] 0012 附件迁移账本 migration 已经受控 admin shell 以单事务应用于 `paca/internal` 与 `paca/main`：新增 `paca_attachment_migration_item`，账本不授权给 Worker runtime role；两端 migration ledger 与 snapshot checksum 已核验。
- [x] 0013 Task Link migration 已经受控 admin shell 以单事务应用于 `paca/internal` 与 `paca/main`：新增 `paca_task_link`、项目作用域 source/target 复合外键、方向/类型唯一约束、自关联约束和双向查询索引；main 应用前后 active Task 均为 12，双方 migration ledger/checksum 已核验，main 的 13 个约束和 4 个索引已核验。
- [x] 0014 附件迁移 active-run guard 已经受控 admin shell 以单事务应用于 `paca/internal` 与 `paca/main`：partial unique index 保证同一源附件最多属于一个非 `rolled_back` run；应用前只读检查确认 main 迁移台账为空且没有跨 run 冲突，两端 checksum 和索引定义均已核验。
- [x] 0015 可靠实时 outbox migration 已以 15 分钟自动过期 admin role 在 `paca/internal` 单事务应用：新增 `paca_realtime_outbox`、2 个调度索引、7 个 Task/Sprint/View 事务触发器和版本化 checksum；runtime role 已扩为 38 表 CRUD 且无 DDL/ledger 权限。`paca/main` 尚未应用，因为本轮只切换 internal Worker。
- [x] 0016/0017 文档投影与 Yjs 快照元数据 migration 已在 `paca/internal` 分别以独立事务应用：新增 `paca_document`、项目实时 outbox trigger、`content_version`、`yjs_revision`、R2 key/SHA-256/字节数/时间元数据和非负约束；两个 ledger checksum、16 列、trigger 与 runtime role 的第 39 张表 CRUD 均已核验。`paca/main` 仍停在 0014，本轮只部署 internal。
- [x] 0018 Agent Task Lease migration 已在 `paca/internal` 以单事务应用：新增 `paca_agent_task_lease` 与追加式 event 表，ledger checksum 为 `6017b070be9add98482a614f230c7f3ce853263595ffbb4697c792fb1f72bc5c`；临时 migration role 的对象已通过 PlanetScale 官方 reassign 移交给 `postgres`，随后删除，runtime role 的 41 表 CRUD 与无 DDL/ledger 权限边界均已核验。`paca/main` 仍停在 0014。
- [x] Better Auth + React Static Assets 的规范入口已固定为 `paca.howlearnwood.com`；Wrangler internal 环境将 Better Auth URL/可信 Origin 仅绑定到该自定义域名。`workers.dev` 仅保留为诊断/回滚入口，不属于认证可信 Origin。验收版本 `783cbcf7-1d29-41d0-9ae2-afde028af068` 已验证根页面、SPA fallback、public health、API 404 与 Origin 拒绝边界。
- [x] 远端烟测已通过 public health、Hyperdrive database health、注册/登录、Session、`GET /api/me`、登出和旧 Cookie 服务端撤销；本地一次性 Secret 与测试凭据已清理。
- [x] React Web 已通过同一 Worker origin 提供；浏览器已验证登录页渲染，远端全链路已验证注册、Session、空工作区读取、登出和会话撤销。
- [x] 已移除首屏对 Google Fonts 的运行时依赖，为简体中文使用明确的跨平台系统字体栈；生产构建不再引用 `fonts.googleapis.com`/`fonts.gstatic.com`，线上截图已复验中文显示。
- [x] internal preview 首页已从只读空数据桥接切换到真实项目列表、统计与创建 API；项目 open task 计数已读取真实 Task 表，但“我的任务”和 Agent 计数仍是明确的空投影，不能据此宣称相应投影或 Agent 领域已迁移。
- [x] internal preview 已收敛未迁移入口：不挂载 Agent 对话浮窗、不展示对话/API Key 导航，直接访问对应 URL 会回到首页；个人资料保持只读，修改密码已改走 Better Auth。版本 `c4ac4c52-0448-47f8-83a8-1ad26367628c` 已部署，避免可见入口继续触发 legacy API 404。
- [x] internal preview 增加统一路由能力清单：版本 `f2242f93-99f0-4883-aa6b-6a034ef02b22` 当时仅开放 `/home` 与 `/profile`；此后能力清单随真实 API 纵向切片逐项扩展，书签或历史链接访问尚未迁移页面仍会在加载 legacy API 前回到首页。
- [x] Paca Permission 首个纵向切片已部署为版本 `5c17e17b-5914-4eba-a340-293368320d61`：Better Auth plugin、默认 Organization provision、真实全局权限投影和 Hono 项目权限中间件均通过 Hyperdrive 远端 E2E；普通用户 `users.read` allow、`settings.write` deny、Session 撤销后 401 均通过，临时账号已级联清理。Worker 当前 36 项测试通过。
- [x] 动态系统角色纵向切片已部署为版本 `72b69b32-74b3-441b-970e-014f481c8bcb`：`GET/POST/PATCH/DELETE /api/v1/admin/global-roles` 已接入 Hyperdrive/PostgreSQL、统一 Hono 权限中间件、内置角色保护、已分配角色删除保护和服务端 grant ceiling；internal preview 仅新增开放 `/admin/global-roles`，其余未迁移管理页继续隐藏。远端已验证 public health 200、未登录角色 API 401 和 SPA 路由 200；React 594 项、Worker 53 项测试通过。
- [x] 项目基础纵向切片已部署为版本 `9168c1bb-b0c0-477f-af44-27aa477b38d7`：`GET/POST /api/v1/projects`、workspace stats、`GET/PATCH/DELETE /api/v1/projects/:projectId` 已接入 Organization/Project 权限中间件与 Hyperdrive；创建事务原子生成 Admin/Editor/Viewer 并将创建者设为 Admin。internal preview 只开放项目根概览，不挂载未迁移的 Socket.IO、任务、文档、Agent、环境或工作流请求。线上已验证 health/SPA 200、未登录项目 API 401、非法 ID 400、未知 API 404；React 598 项、Worker 68 项测试通过。
- [x] 项目访问控制纵向切片已部署为版本 `162c2eeb-8c90-4a3b-b408-c95a388af76a`：动态项目角色 CRUD、权限 grant ceiling、内置角色不可改删、已分配角色删除保护、人类成员列表/添加/换角/移除、最后一名 Admin 保护和项目范围候选用户接口均进入 Hono/Hyperdrive；Agent 成员入口保持关闭，等待 Better Auth Agent Auth。internal preview 新增 Team 与仅含 General/Roles/Danger 的安全 Settings 页面，避免加载任务类型、状态和自定义字段 legacy API。远端已验证 Team/Settings SPA 200，未登录 roles/members/candidates/users API 均为 401；React 600 项、Worker 76 项测试通过。
- [x] Organization 访问控制纵向切片已部署为版本 `9b2f2854-ba6c-4feb-b6d5-9d9cb8aa41c1`：Organization 动态角色 CRUD、多角色原子替换、grant ceiling、内置角色不可改删、已分配角色删除保护和最后一名 OWNER 保护均进入 Hono/Hyperdrive；Better Auth 继续独占 Organization 成员加入/移除生命周期，Paca 插件只管理业务角色。internal preview 新增 `/admin/organization-access`，并继续隐藏或重定向未迁移导航，避免 legacy API 404。远端已验证组织权限 SPA 深链 200、未登录 API 401；React 606 项、Worker 85 项测试、Drizzle check、Wrangler types 和 deploy dry-run 全部通过。
- [x] Task 基础纵向切片已部署为版本 `9ac45277-b775-4a51-b6e3-33300f93adf8`：新项目在创建事务中初始化 Task/Bug 类型、Backlog/To Do/In Progress/Done 状态和项目任务编号；Hono 已提供类型/状态读取、任务列表与搜索、创建、读取、更新状态/字段和软删除，并由 Project 权限中间件、数据库约束和多 Assignee 关系保护。internal preview 新增真实 `/projects/:projectId/tasks` 页面，支持搜索、创建、状态变更和归档；Task 详情、Sprint、视图、自定义字段与活动记录仍保持隐藏。线上已验证根页面和任务 SPA 深链 200、未登录任务 API 401；React 607 项、Worker 93 项测试及完整 Worker check 通过。
- [x] Task 详情与活动纵向切片已部署为版本 `60497c45-bf70-4238-881c-09d46008c62b`：internal preview 的任务标题会进入真实详情页，可编辑标题、状态、类型、优先级、日期、标签、描述、故事点和多 Assignee，并支持归档；任务创建、字段变更和归档会与任务写入在同一 PostgreSQL 事务记录服务端可信动态，评论支持读取、创建及仅作者编辑/软删除。线上根页面与任务 SPA 深链均为 200，未登录活动 API 为 401；React 610 项、Worker 101 项测试，以及类型、Drizzle、TypeScript、Biome 和 Wrangler dry-run 均通过。
- [x] Sprint、任务视图与自定义字段基础纵向切片已部署为版本 `8782c126-7c34-49ea-b6d2-66231d8bfdad`：Hono/Hyperdrive 已提供 Sprint CRUD/完成、项目和 Sprint 作用域视图 CRUD/排序、手工任务位置、自定义字段 CRUD，以及 Task 的 Sprint 归属和自定义字段写入校验。internal preview 新增安全的 Backlog、Timeline、Sprint 页面和 Settings 自定义字段页，任务点击继续进入已迁移详情页，不挂载仍会请求附件/链接 legacy API 的完整交互弹窗。线上三个 SPA 深链均为 200，未登录 Sprint/自定义字段 API 为 401；React 613 项、Worker 114 项、Drizzle、TypeScript、Biome、Wrangler types 与 deploy dry-run 均通过。
- [x] 高级任务交互视图契约已部署为版本 `67920577-f0ac-4c7a-a669-8cdd7ec21b02`：Task 列表已支持 Sprint/状态/Assignee/类型多选与空值筛选、自定义字段筛选、日期/故事点/优先级/标签范围、内置与自定义字段排序、按 View 手工位置排序、稳定不透明游标、全量计数和数值字段汇总，并返回 `view_position`/`view_group_key`。internal preview 的 Backlog、Timeline、Sprint 已恢复现有完整 `InteractionLayout`，任务点击转到已迁移详情页，避免加载附件/链接等 legacy 请求。真实 PlanetScale PostgreSQL 已用只读综合 SQL 验证 JSONB、数组、关联与排序语法；线上三个 SPA 深链为 200，完整查询未登录边界为 401，未知 API 仍为 404；React 613 项、Worker 116 项及完整 Worker check 通过。根 `DATABASE_URL` 仍因 SASL 凭据失效不能执行直接 repository 烟测。
- [x] Better Auth Agent Auth 首个纵向切片已部署为版本 `0b2c41dc-02af-4356-a2f8-c247eb0a5afb`：锁定 `@better-auth/agent-auth@0.6.2`，Agent/Host/Grant/Approval schema、PostgreSQL secondary storage JTI 防重放原语、Paca Capability/constraints、delegated 用户实时权限交集、审计与 Project/Task 执行边界均已接入。internal preview 的 `/admin/agents` 改走 Agent Auth list/revoke，`/device/capabilities` 提供 device authorization 审批页；`/.well-known/agent-configuration` 已加入 Worker-first，线上返回 JSON 而非 SPA HTML。Agent list/approval 未登录边界均为 401，React 619 项、Worker 128 项及完整 Worker check 通过；完整注册→审批→JWT→重放远端 E2E 尚未完成。
- [x] internal preview 的 legacy 页面 404 防线已部署为版本 `d3d56edf-87f6-473b-9e49-238b9eb3b112`：路由能力清单现在同时约束认证布局、命令式导航和全局快捷键；项目 Agent 旧 UI、Documents、Environments、Conversations、Automation 的列表及叶子路由均在 loader 发出 legacy API 请求前回到项目概览。未迁移能力仍保持不可用而不伪造数据；React 620 项、Worker 128 项及完整 Worker check 通过。
- [x] Agent Auth delegated 协议增量已部署为版本 `c32678a7-46a7-4e8a-8e98-bc741dd1f9c4`：真实 Agent Auth 测试完成 Host enrollment→delegated 注册→device approval→Agent JWT→Capability 执行，并覆盖错误 `aud`、过期 JWT、`jti` 重放、无/过期 Grant 和跨 Project constraint 拒绝；统一 `getAgentSession()` Hono middleware 与 `/api/v1/agent/projects/:projectId` 已接入。管理页新增 Host 创建/列表/级联撤销和一次性 enrollment token 展示，审批页显示当前用户可见的 Capability/constraints。React 621 项、Worker 137 项与完整 Worker check 通过；线上根页面、Agent 管理/审批 SPA 与 discovery 为 200，Host list 和 Agent Project 路由未登录均为 401。
- [x] Autonomous fail-closed 增量已部署为版本 `3cce89a6-d6c1-40b5-82c0-43bb82c4bcc2`：只有设置至少 32 字符的独立 `AUTONOMOUS_HOST_ENROLLMENT_SECRET` 后 discovery 才公布 autonomous，未知 Host 注册还必须同时通过 bootstrap header、Ed25519 签名、`aud`、`exp` 和 `jti`；弱 Secret 会导致配置失败。无用户 Agent 初始无 Capability，Project 审批人可通过 Paca Better Auth 扩展授予/撤销 15 分钟、单 Project `project.read` Grant，Project/Task 读取不伪造普通用户权限，Task 写入在可信 Agent actor 尚未迁移前明确拒绝。真实内存协议测试覆盖错误/正确 Secret、注册、Grant、执行、撤销后 `grant_revoked`；React 623 项、Worker 143 项及完整 check 通过。线上未配置该 Secret，已确认 discovery 仍只有 delegated，管理页显示“未配置”，Grant/撤销端点未登录均为 401。
- [x] 可信 Agent Task actor 增量已部署为版本 `bea88864-884a-44d3-a9a0-f7a944045eb0`：Task mutation 采用服务端构造的 `user|agent` 判别主体，Task Activity 同时保存不可变 actor subject 与可空 User/Agent 展示关联；autonomous `task.write` 在 active Grant、Organization/Project/Task/field/operationMode/validUntil constraints 全部通过后可用，不伪造 Better Auth 用户或 ProjectMember。前端活动契约显式区分 actor 类型，只有 user comment 可按当前用户 ID 编辑。React 623 项、Worker 143 项及完整 Worker check 通过；线上 health、SPA 深链与 discovery 已复验，未配置 bootstrap Secret 时仍只公布 delegated。
- [x] M6 R2 任务附件首个纵向切片已部署为版本 `e0f0b090-d2fd-4586-b9c8-7eb7981fb9a4`：internal 环境绑定隔离 bucket `paca-attachments-internal`；Hono 提供受 `tasks.read`/`tasks.write` 保护的初始化、单次/分片上传、完成、主动取消、列表、受保护下载与软删除 API，R2 对象不公开且数据库仅保存作用域、对象 key、大小、SHA-256 与 ETag。浏览器失败路径会调用取消接口，multipart 在标记数据库失败前先 abort，单次上传删除未完成对象。任务详情已恢复附件 UI。真实远端 smoke 通过注册/最小 `projects.create` 测试夹具、项目/任务创建、R2 上传、服务端 SHA-256、列表、206 Range 下载、安全响应头和删除后隐藏；临时用户、角色、项目、元数据和 R2 对象均已精确清理。React 623 项、Worker 156 项、Drizzle、TypeScript、Biome、Wrangler types 和 dry-run 均通过；线上 health/SPA 为 200，未登录取消接口为 401。
- [x] 前端懒加载页面的部署版本错位恢复已部署为版本 `62630179-5b81-4f79-9fee-7b289183d514`：入口 HTML 在 Vite `vite:preloadError` 时自动刷新一次以获取当前 asset manifest，并使用 60 秒 Session guard 防止缺失资源造成无限刷新。线上已确认新恢复脚本存在，`/home`、`/profile`、Project Tasks 深链均返回 SPA HTML 200，public health 为 200；完整 Worker check、156 项测试和 dry-run 通过。
- [x] 附件删除恢复与安全清理增量已部署为版本 `7efca4b2-b89f-4b15-bd0b-1e9b9f206141`：软删除设置 30 天 `purge_after`，恢复前同时检查数据库抢占状态与 R2 对象存在性，任务详情展示仍在保留期内的最近删除项并支持恢复，活动流记录可信 `task.attachment.restored`。清理服务使用数据库短事务、`FOR UPDATE SKIP LOCKED` 和 stale claim 分批认领到期附件、失败上传与超时 pending 上传，R2 删除成功后才级联硬删除元数据，失败项释放供下次重试；scheduled handler 已进入 Worker，但 Wrangler 未配置 Cron，避免当前 internal→main 临时连接自动执行物理删除。React 625 项、Worker 161 项、完整 Worker check 和 dry-run 通过；线上 health/任务深链为 200，最近删除列表与恢复端点未登录均为 401。
- [x] internal 附件定时清理已部署为版本 `0105e236-a5ed-4718-b57b-4aa6f871ffc6`：scheduled handler 只有在显式启用、运行于 internal/production 且收到与代码/部署守卫一致的 `15 10 * * *` Cron 时才执行；Wrangler internal 环境注册每日 UTC 10:15 trigger。真实隔离 R2 smoke 完成上传→Range 下载→软删除→恢复→再次软删除，候选审计确认除该对象外到期/废弃/已占用数量均为 0；首次 Cron 日志为 `claimed=1/purged=1/failed=0`，之后 PostgreSQL 附件/文件元数据、due/claim/abandoned 计数均归零，原 R2 key 返回不存在。Worker 32 个文件/182 项测试、类型、Biome、配置守卫、dry-run、Web production build 和部署均通过。
- [x] internal 附件韧性真实 smoke 已完成：5 MiB multipart part 上传后主动取消，完成请求返回 404、附件列表为空且 R2 key 不存在；另以临时 Editor 用户发起 multipart，管理员移除项目成员后，原 Session 的 part 上传与取消立即 403，恢复成员后仅执行 abort，再次移除后新 upload initiate 仍为 403。两轮随机 smoke Project/Task/File/User/Session 均以精确 ID 级联清零，未影响 Demo 数据。
- [x] Agent 驱动 Demo Backlog 验收的能力增量已部署为版本 `d0fe093b-4ad9-4e15-8fd0-85923438cc5a`：`task.write` 增加严格受 `taskId + description + collaborate` 约束的描述写入，新增 Project-scoped `task.create` 以默认状态创建 Backlog 工作项；delegated 写入使用真实 Agent actor，用户仅参与实时权限交集。新增本机 Host→Agent 注册、Ed25519 `host+jwt`/`agent+jwt`、唯一 JTI 和批量执行 CLI，Agent 私钥保持 Git-ignored `0600`。29 个测试文件、169 项测试、类型、Biome、Drizzle、Web build、Wrangler types/dry-run 均通过，线上 health 与 Capability catalog 已验收；真实 Demo/DEMO-1 修改等待用户在应用内浏览器登录并批准 device authorization。
- [x] Task 层级与关联关系增量已部署为版本 `bb40934c-6c27-4226-9b63-278e1a97bc0a`：既有 `parent_task_id` 已补最长 50 层的祖先遍历、循环/跨项目/归档父级校验；新增 `paca_task_link` repository、`GET/POST/DELETE .../links`、`blocks|relates_to|duplicates` 方向语义、可信 Task Activity 和 Project `tasks.read`/`tasks.write` 授权。internal task 详情页恢复父级选择、子工作项和关联工作项 UI；项目任务选择器改为 Worker 最大 100 条/页的有界游标遍历。真实登录 API smoke 通过正反向读取、反向重复 409、自关联 400、删除 204，并确认临时关系已清理；React 59 个文件/636 项测试、Worker 31 个文件/177 项测试、完整 Worker check、Web TypeScript 和目标 Biome 均通过。全量 Web lint 仍被两个与本增量无关的既有格式问题阻断。
- [x] M6 历史附件迁移工具已形成可执行纵向切片：Go CLI 提供默认只读 preview、显式确认的 plan/apply/rollback、全 run verify、源 metadata/目标 scope 漂移拒绝、R2 `If-None-Match: *` 原子条件创建、SHA-256 全量校验、所有权回滚、分页游标保护及按 bucket/key 二次确认的 orphan audit/delete。`0014` 阻止同一源附件被多个 active run 并行认领；失败导入与纯 planned 项可安全回滚，未知 run 或任一未 imported 状态都会让 verify 失败。运维文档固定凭据/endpoint/确认串/执行顺序和恢复边界；专项 race test、Go vet、Go API 全量测试及 Worker 31 文件/178 项完整 check 均通过。真实 legacy→R2 演练仍需单独提供旧数据库与旧对象存储的只读凭据。
- [ ] 使用真实登录 Session 完成 Sprint 创建→启动→任务移入→完成→任务回到 Backlog、自定义字段 CRUD 和视图 CRUD 的远端浏览器 E2E；本轮应用内浏览器连接超时，只完成无凭据边界与 SPA 深链验收，不能据此勾选已登录 UI E2E。

## M1：Worker、Hono 与 Hyperdrive 基础

### 工程骨架

- [x] 确定 Worker package 路径和名称，避免与现有 Go API、Realtime 服务混淆。
- [x] 建立独立 `package.json`、TypeScript 配置、测试配置和本地开发命令。
- [x] 新建 `wrangler.jsonc`，至少配置当前日期的 `compatibility_date`、`nodejs_compat` 和 `HYPERDRIVE` binding。
- [x] 生成并提交 Worker binding 类型，确保 `env.HYPERDRIVE` 为 `Hyperdrive` 类型而不是 `any`。
- [x] 建立 Hono 应用入口、统一错误响应、request ID 和结构化日志。
- [x] 添加不访问外部资源的 `GET /health`。

### 数据库连通性

- [x] 安装并锁定当前 Cloudflare Hyperdrive 支持的 `pg`、Drizzle ORM 和 Drizzle Kit 版本。
- [x] 实现按请求创建并在 `finally` 中关闭的 `pg` client/Drizzle db factory。
- [x] 运行时只使用 `env.HYPERDRIVE.connectionString`，禁止读取 Worker 中不存在的根目录 `.env`。
- [x] 添加受保护的数据库健康检查，执行无副作用查询并读取当前 database/schema 标识但不返回其值。
- [ ] 确认 Hyperdrive dashboard 出现成功查询和连接指标。
- [x] 验证数据库错误不会把连接串、用户名、主机名或查询参数返回给客户端。

### M1 验收

- [x] 本地测试通过。
- [x] `wrangler dev` 下 `/health` 正常。
- [x] 预览/开发 Worker 中数据库健康检查通过 Hyperdrive 成功返回。
- [x] 连续 20 次、并发度 5 的真实 Hyperdrive 请求全部成功，client 在 `finally` 中关闭且响应不含敏感信息。
- [x] 记录预览环境部署与回滚命令。

## M2：Drizzle Schema 与迁移基线

- [x] 盘点 `services/api/migrations` 和 `services/api/internal/repository/postgres` 使用的 PostgreSQL 特性。
- [x] 首先在 `paca/internal` 空 development branch 验证 migration；随后因环境尚未上线且用户明确授权，将同一 migration 应用于 `paca/main` 作为首版内部预览目标。
- [x] 建立 PostgreSQL Drizzle schema 目录和 `drizzle.config.ts`。
- [x] `drizzle.config.ts` 仅从本地/CI `DATABASE_URL` 读取直接连接串，不使用 Hyperdrive runtime URL。
- [x] migration 使用临时 admin role；internal runtime 已切换到持久、无继承管理角色且仅显式 38 表 CRUD 的 `paca-worker-internal` role 与独立 Hyperdrive，migration ledger 不授予 runtime。
- [x] 生成第一版 Better Auth Core/Organization + Paca Project Permission SQL migration，并人工审查 UUID、索引、复合外键、默认值和 migration ledger。
- [ ] 建立 migration dry-run/测试数据库流程，禁止生产启动时自动 `push` 或自动迁移。
- [ ] 建立 PostgreSQL repository contract test 基础设施。
- [ ] 验证 PlanetScale branch、备份/恢复和回滚策略。

### M2 验收

- [x] 新数据库可从零应用全部 Worker migrations；已在隔离的空 `paca/internal` branch 验证。
- [x] 已有测试数据库可安全升级且保留数据；0001 已用 2 用户/2 Session 合成数据验证首位 `SUPER_ADMIN/OWNER`、后续 `USER/MEMBER`、默认 Organization 与 Session 回填。
- [x] Worker 通过 Hyperdrive 对迁移后 schema 完成 Better Auth 用户与 Session 基本读写。
- [ ] migration 回滚或前滚修复方案经过演练。

## M3：Better Auth Core

- [x] 在 Hono 中挂载 Better Auth `/api/auth/*`，并确保路由位于 catch-all 之前。
- [x] 新增由 Better Auth 数据库 Session 保护的 `GET /api/me`，未认证返回 401，响应不暴露 Session token。
- [x] 实现通过 Drizzle/PostgreSQL adapter 使用同一 Hyperdrive 数据库的 runtime factory；待 internal Hyperdrive 后做真实验收。
- [x] 固化 Better Auth base URL、严格 trusted origins、七天数据库 Session、`Secure`/`HttpOnly`/`SameSite=Lax` Cookie 和 CORS 策略。
- [x] 已将 Better Auth Secret 写入 internal Worker Secret；Cloudflare 列表只确认名称，不读取值，本地一次性明文已清理。
- [x] 将 Better Auth Core 与 Organization schema 纳入版本化 Drizzle migration，禁止运行时自动改表。
- [x] 以 Better Auth 官方 memory adapter 完成协议测试，并以真实 PostgreSQL/Hyperdrive 完成注册/登录、读取 Session、`GET /api/me`、登出和旧 Cookie 服务端撤销的远端 E2E。
- [ ] 定义现有 Paca 用户向 Better Auth User/Account/Session 的迁移和 ID 映射策略。
- [x] 已覆盖 auth handler、可信 Origin、CORS preflight、Cookie 属性、密码下限、缺失 Origin 的 Cookie 写请求、Session 和撤销协议测试，并完成真实远端 E2E。
- [x] 前端登录、注册、当前用户和登出已接入 Better Auth HTTP API；服务端仍是最终授权边界。

### M3 验收

- [x] 用户可在预览环境完成注册/登录、跨请求保持数据库 Session 并退出。
- [ ] 未登录、过期、撤销和伪造 Session 均被拒绝。
- [x] 现有结构化日志、API 响应和 Worker bundle 不包含 Better Auth Secret 或数据库凭据。

## M4：Paca Permission Better Auth 插件

### 权限模型

- [x] 以 `services/api/internal/platform/authz/permissions.go` 为当前权限词汇迁移基线。
- [x] 定义静态 resource/action statement，以及 system/organization/project 三种真实业务作用域。
- [x] 保留 Paca 的 Project、ProjectMember、ProjectRole、RolePermission 语义，不把 Project 映射为 Better Auth Organization 或 Team。
- [x] Better Auth Organization 只表示真实租户/组织/工作区；当前单工作区部署已实现 `paca-default` 初始化、既有用户回填和注册/登录幂等 provision。
- [x] 定义动态角色创建、修改、删除、分配和权限上限规则。
  - [x] 系统动态角色的创建、修改、删除、大小写无关名称冲突、内置角色不可改删、已分配角色不可删除和 grant ceiling 已实现并接入 React 既有 API contract。
  - [x] 系统角色多角色分配已实现：替换集合、目标角色存在性、grant ceiling 与最后一名 `SUPER_ADMIN` 保护在同一事务/advisory lock 内执行。
  - [x] Project 动态角色 CRUD、单角色分配、内置角色保护、已分配删除保护、grant ceiling 与最后一名 Admin 保护已实现并部署。
  - [x] Organization 动态角色 CRUD、多角色分配、内置角色保护、已分配删除保护、grant ceiling 与最后一名 OWNER 保护已实现并部署；成员加入/移除仍由 Better Auth Organization 生命周期负责。

### 插件与 API

- [x] 实现 `pacaPermission` server plugin schema、endpoint 和 middleware。
- [x] 实现类型化 client plugin，仅用于 UI 能力展示和管理页面。
- [x] 实现 `hasSystemPermission`、`hasOrganizationPermission` 和 `hasProjectPermission` 服务端入口。
- [x] 实现 Hono `requireProjectPermission()` 统一中间件，禁止路由直接查询角色表；首个项目权限投影端点已接入。
- [x] 静态 statement 覆盖 `projects`、`projectMembers`、`projectRoles`、`tasks`、`sprints`、`docs`、`agents`、`environments`、`workflows` 和 `settings`。
- [ ] 将对象归属、状态转换和数据完整性校验留在领域服务，不复制为另一套 RBAC。

### 迁移与切换

- [ ] 建立旧 Go Authorizer 与 Better Auth 的 shadow decision comparison，记录差异但不影响请求结果。
- [ ] 覆盖全局权限、项目权限、多角色、wildcard、无成员关系和 Agent 旧权限的迁移样本。
- [ ] 修复全部 decision 差异并完成回归测试。
- [ ] 将 Better Auth/`pacaPermission` 切换为唯一用户权限权威来源。
- [ ] 删除或正式接管旧 `PermissionStore`、`Authorizer`、legacy role 合并和重复权限 schema。

### M4 验收

- [ ] 同一用户可在不同项目拥有不同角色。
- [ ] 权限被收回后，新 HTTP 请求和实时连接都不能继续使用旧权限。
- [x] 前端隐藏按钮不能代替服务端鉴权，直接调用项目权限 API 已覆盖 401/403/allow 三种服务端结果。
- [ ] 不再存在长期双写或双权威权限来源。

## M5：Better Auth Agent Auth

- [x] 锁定并记录 `@better-auth/agent-auth@0.6.2`；通过 `pacaAgentAuth` 适配层隔离仍在演进的 API。
- [x] 将 Agent Auth 的 Agent、Host、Grant、Approval schema 纳入受审查 migration。
- [x] 定义 Paca Capability 目录，至少包含项目读取、任务读取/修改、文档读取/编辑、环境连接和 Workflow 执行。
- [x] 为每个 Capability 定义 constraints schema：Organization、Project、Document、Task、字段、操作模式和有效期。
- [x] 实现 Agent discovery、Host enrollment、delegated Agent 注册、审批和执行协议；真实 Better Auth 协议测试覆盖 Host/Agent Ed25519 JWT 全链路。
- [x] 为任务领域执行器加入 `task.create` 和 `task.write(description)`：创建 Grant 绑定 Organization/Project/操作模式/短有效期，描述修改额外绑定单一 Task/字段；delegated 与 autonomous 的实际任务写入均使用 Agent actor，不能以被代理用户冒充审计主体。
- [x] 提供可复用的本机 Host enrollment CLI：固定校验同源 discovery/issuer/capability endpoint，仅上传 Ed25519 public JWK，私钥原子写入 Git-ignored `0600` 配置且拒绝覆盖；远端已用真实一次性 token 注册 active delegated Host，并以 5 项专项测试验证协议和落盘边界。
- [x] 完成真实远端 delegated Agent E2E：本机 Host 注册短时 Agent，通过 Better Auth 新鲜 Session 审批最小 `project.read`、`task.read`、`task.write(description)`、`task.create` Grant，随后以每请求唯一 `jti` 的短期 Agent JWT 读取并更新 DEMO-1、创建 DEMO-2～DEMO-12；最终用用户领域 API 将 11 条工作项挂为 DEMO-1 子项并验证父级筛选总数。任务写入使用可信 Agent actor，审批临时 Session 在执行后注销；Agent Auth 专用审计持久化已由下方独立 smoke 重新验收。
- [ ] 实现 autonomous Agent 模式；必须先定义不伪造普通用户的主体映射、审批与 Paca 领域审计语义。
- [x] 实现 autonomous 的 fail-closed Host bootstrap、合成 Agent session subject、受 `agents.approveGrant` 保护的最小 Project Grant/撤销和 project/task 读取；未配置 bootstrap Secret 时功能与 discovery 均关闭。
- [x] 为 Task Activity 增加可信 Agent actor，并在 active Grant 与完整 constraints 边界后开放 autonomous `task.write`。
- [ ] 为 document/environment/workflow 接入对应领域执行器。Document read/edit 已形成未部署候选：Better Auth Agent Auth 先验证 JWT/active Grant/constraints，再校验真实 Document scope；delegated 同时与当前 `docs.read`/`docs.write` 取交集，autonomous 使用最小 active Grant，可信 Agent ID 由 Session 注入。Environment/Workflow 仍未实现，且 Document 远端 E2E 尚未验收，因此本项不勾选。
- [x] 实现 device authorization 审批流程及对应 UI；审批页展示当前用户可见 Agent 请求的 Capability/constraints，管理页支持 Host enrollment token 创建、Host 列表与级联撤销；重复打开不同授权链接时按 Agent ID/授权码重新挂载表单，失败时展示 Session 新鲜度、项目审批权限和 constraints 的明确错误码。真实远端 Agent Host/审批/任务执行 E2E 已完成，Runner 迁移仍由独立待办追踪。
- [x] 修复 device authorization 登录恢复流程：未登录访问授权链接时使用经过同源校验的 `return_to` 保留 Agent ID/授权码并在登录后返回；Session 超过 5 分钟时在原页面重新验证当前账号并自动重试同一审批，不再要求退出或重新生成链接；前端优先展示 Paca 领域错误而非通用 HTTP code。46 项相关测试、internal production build 和远端 pending→approved→active 烟测通过，部署版本 `ba88e529-6a8e-45ef-a801-c2f151859155`。
- [x] 实现 `getAgentSession()` Hono middleware，验证 JWT、`aud`、`exp`、`jti`、active Grant 和 constraints；首个 `/api/v1/agent/projects/:projectId` 路由复用同一边界并再次检查 delegated 用户当前 Project 权限。
- [x] Delegated Agent 的最终权限取 active Grant 与被代理用户当前 Paca 权限的交集。
- [ ] Autonomous Agent 只依赖审批后仍 active 的 Grant 和 constraints。
- [x] 重新验收 Agent Auth 专用审计持久化：internal 权威表复制前已有 24 条历史记录，覆盖 `agent.created`、`agent.revoked`、`host.created/enrolled`、`capability.approved/executed`；新 `paca-worker-internal` role 显式取得该表 CRUD。部署版本 `44d544c6-fbe2-482a-a75c-23fd56b2f592` 后，以现有 delegated Agent 为 Demo Project 临时授予十分钟 `project.read`、执行只读 Capability 并立即撤销；自定义撤销端点只有在同步等待 `capability.revoked` 审计 INSERT 成功后才返回 200，因此确认新 runtime role 的新鲜写入路径正常，随后 Agent status 仅显示 revoked、无 active Grant。可重复 `smoke:agent-audit:internal` 已纳入工程，失败路径也会尝试撤销；审计 INSERT 失败日志仅保留经过白名单校验的 PostgreSQL SQLSTATE、constraint/table 标识符，不记录连接串、SQL、密码、私钥或原始错误消息。任务 Activity 的可信 Agent actor 写入路径仍正常。
- [x] 普通 Better Auth API Key 不作为 Agent Runner 身份；当前 Agent UI 和执行边界只调用 Agent Auth。
- [ ] 将 `services/agent-runner` 从 legacy `PACA_API_KEY` 身份迁移到本机 Agent Host 配置，完成 delegated Agent 注册、device approval、短期 `host+jwt`/Agent JWT 轮换和 Project-scoped Capability 执行；完成前不得把 Host enrollment 宣称为 Runner 已接通。

### M5 验收

- [x] 无 Grant、过期 Grant、错误 Project constraint、重放 JWT 和错误 `aud` 均被拒绝；`agent-auth-protocol.test.ts` 使用真实 Agent Auth 0.6.2 注册/审批/JWT 协议验证。
- [x] 用户离开项目或失去权限后，Delegated Agent 立即失去对应有效能力；执行边界单元测试已覆盖移除权限后的拒绝结果。
- [ ] Autonomous Agent 的 Grant 可审计、可撤销且最小化。

## M6：R2 文件与附件

- [ ] 创建开发/预览/生产隔离的 R2 bucket 和 Wrangler binding；三个 bucket 均已创建，development/internal binding 和守卫已完成，production binding 仍待生产 Worker/Hyperdrive 环境一起配置和验收。
- [x] 定义对象 key、租户/项目隔离、Content-Type、512 MiB 大小限制、精确 Content-Length、服务端 SHA-256/ETag 和安全下载响应策略。
- [x] 新附件先写 R2，数据库只保存元数据、哈希和对象 key；R2 与数据库完成之间保留可重试边界，multipart 已覆盖“对象完成、数据库未提交”重试。
- [x] 实现受 Better Auth/Paca Permission 保护的上传、下载和删除流程；下载保持同源鉴权，删除当前为可恢复的元数据软删除。
- [x] 建立历史对象迁移、校验、回滚和孤儿对象清理工具；实现位于 `services/api/cmd/attachment-migrate` 与 `internal/platform/attachmentmigration`，运行手册为 `docs/cloudflare-attachment-migration.md`。真实数据 preview/apply 仍需旧数据库和旧对象存储凭据，并且只有 preview `skipped=0`、verify `failed=0` 且 succeeded 等于 plan 数量后才允许切流。
- [x] 实现删除恢复与清理安全边界：30 天保留期、R2 存在性检查、恢复/清理抢占互斥、过期 claim 重试、批量上限和废弃上传保留期均有单测；远端附件 smoke 脚本已扩展为删除→最近删除→恢复→再次删除流程。
- [x] internal 数据库与 bucket 完成环境隔离后，scheduled handler 已配置每日 UTC 10:15 Cron；运行时显式 enable、environment 和精确 cron 三重 fail-closed 门控及部署守卫均已覆盖，首次真实执行完成唯一 smoke 对象的 R2 与 PostgreSQL 物理清理，失败数为 0。
- [x] 验证大文件、重复上传、取消上传、权限撤销和删除恢复：multipart 边界/重复完成/取消顺序、恢复/对象缺失/清理失败重试均有单测；真实 internal smoke 覆盖小文件上传/Range/软删除/恢复/scheduled 清理、5 MiB multipart part 上传/abort/完成拒绝，以及成员撤销后旧 Session 的上传/取消/重新发起全部即时 403，所有测试数据库与 R2 状态均已精确清理。

## M7：PartyServer 实时事件

- [x] 盘点 `services/realtime/src/server.ts` 的 Socket.IO 鉴权、Project room 和 User room 行为；新协议保留项目级 tasks/docs/workflows/sprints namespace 与用户私有通知/Agent 事件语义，不接受客户端自行发布服务端事件。
- [x] 盘点 `services/realtime/src/subscriber.ts` 的 Valkey Pub/Sub 事件并区分在线广播与可靠事件；已补齐旧订阅器遗漏的 `automation.*` → workflows 映射，Valkey Streams/可靠处理仍保留在后续 Queue/Workflow 迁移范围。
- [x] 实现 ProjectParty 与 UserParty，使用稳定 room name 路由并启用 WebSocket Hibernation；Wrangler 已声明独立 DO binding 与 `new_sqlite_classes` 迁移，连接状态写入 WebSocket attachment 以便休眠恢复。
- [x] Worker 在路由到 PartyServer 前验证用户 Session 或 Agent Auth：浏览器必须同源且按 `pacaPermission` 计算可读 namespace；Agent 必须持有仍有效、精确到 Project+Task/Document 的 active read Grant，UserParty 不接受 Agent。
- [x] 设计绑定 actor、scope、action、expiry、nonce 和权限版本的短期连接 capability；可信 attachment 现已绑定 actor、Session、room scope、namespace/object action、5 分钟上限、JWT/Session expiry、nonce 和规范化权限摘要。项目角色/成员变更、项目归档、Agent Grant 撤销与用户 sign-out 会通过 DO RPC 写入持久失效时间并关闭匹配连接，新连接必须重新经过 Better Auth/Paca Permission/Agent Auth 判定。
- [x] 已迁移写入的 Task/Sprint/View 可靠事件先由 PostgreSQL 事务触发器写入 outbox，再由 request `waitUntil`/每分钟恢复 Cron 批量发送到 Cloudflare Queue；Queue consumer 按消息调用 ProjectParty/UserParty，成功后标记 delivered，失败指数退避并在超过重试上限后进入独立 DLQ。广播本身不作为持久队列，outbox claim 支持 lease/stale recovery，DO SQLite 与浏览器均按 outbox ID 去重。尚未迁移的 Document/Workflow 事件随 M8/M9 接入相同契约。
- [x] 已完成重连、休眠恢复、权限撤销、重复消息和滚动发布测试：Workers Runtime 强制 eviction 后验证 attachment 恢复、actor 撤销、连接关闭和旧 capability 重连拒绝；纯协议/鉴权单测覆盖 project/user/Agent 作用域、过期、事件大小和伪造 header；PartySocket 客户端覆盖同源 UserParty、按项目引用计数、事件分发、重连、重复 ID 去重和登出清理。真实已登录 internal smoke 收到可靠 `task.updated`，空闲 12 秒后同一连接 pong，显式重连后取得新 capability/事件；同一 outbox ID 以 stale recovery 重投后 `attempts=2/delivered=true` 且客户端未收到第二次；滚动部署关闭旧连接后重新鉴权连接、pong 和新事件均成功。无凭据完整 WebSocket Upgrade 保持 401。

当前 M7 验收版本为 internal Worker `785a98ac-bf37-49d9-b3bd-b86bd379f101`。React 59 个测试文件、624 项测试，Worker 38 个测试文件、203 项测试，以及 Workers Runtime 1 个文件、3 项 DO/WebSocket 测试全部通过；完整 check/dry-run/真实部署识别 `REALTIME_EVENTS`、ProjectParty/UserParty、独立 internal Hyperdrive/R2。`smoke:realtime:internal` 固化真实 Session、临时 Project/Task、可靠事件、空闲 pong、重连和滚动发布验收；重复投递由受控 stale outbox 重投验证。两轮临时 Project、20 条关联 outbox 和 1 个异常路径遗留 Bun Session 已精确删除。

## M8：Yjs DocumentParty

当前 M8 验收版本为 internal Worker `1e7d9965-6a35-4701-a656-f0e96306e970`。React 60 个测试文件/628 项（前端本轮未改）、Worker 44 个测试文件/243 项、Workers Runtime 2 个测试文件/14 项全部通过；internal production build、Drizzle check、Wrangler types、Biome、deploy dry-run、真实部署和 public health/SPA 200 均通过。Document Queue 部署后显示 1 个 producer 和 1 个 consumer，DLQ 保持独立；真实 smoke 最终 revision 4 已物化到 PostgreSQL，精确 R2 对象为 309 字节且 SHA-256 与数据库一致。随后用一次性、固定文档范围的临时 Worker 向正式 Queue 投递 revision 4/3/4 和尚未生成的 revision 5：重复与乱序消息未回退投影，revision 5 从 attempt 1 重试到 6 后进入 DLQ；PostgreSQL 与 R2 的 revision、对象大小和 SHA-256 均未变化。故障注入完成后已移除临时 DLQ consumer 和 Worker，正式 Queue 重新核验为 `paca-worker-api-internal` 的 1/1 producer/consumer，DLQ 为 0/0。Agent 最终为 revoked，两个 Document Grant 均为 revoked，临时 Project 为 archived，Session 已注销。首页在既有登录浏览器中真实渲染，但 Documents 深链的浏览器自动化两次在等待加载时超时，因此不把 BlockNote UI 视为已验收。

- [x] 盘点 `services/api/internal/repository/postgres/document_repository.go` 的文档结构和快照语义；旧实现保存当前 BlockNote JSONB 和整份 JSON snapshot，不保存 Yjs state vector/update，因此不能直接作为协作恢复源。
- [ ] 为 BlockNote 接入 Yjs 和 `y-partyserver/provider`。代码、迁移、资源和部署均已完成，原始用户 WebSocket 远端重连已通过；仍需取得真实浏览器中 BlockNote 编辑、刷新恢复和独占只读提示的可靠证据后勾选。
- [x] 实现一篇文档一个 DocumentParty/YServer，使用稳定 `documentId` 寻址；Wrangler 已声明独立 DO binding 和 `v2-document-party` SQLite class migration。
- [x] 实现 `onLoad`、`onSave`、增量 update、checkpoint、恢复与压缩清理；更新先同步写入 DO SQLite 再广播，阈值 checkpoint 清理已覆盖真实 Workers Runtime 驱逐恢复测试。
- [x] DO SQLite 保存实时增量；R2/业务数据库保存长期快照和可查询业务视图。隔离 Queue/R2、0016/0017、不可变 R2 修订对象、SHA-256/大小元数据、服务端 BlockNote JSON 和 PostgreSQL 高修订保护均已真实验收；最终 revision 4 的精确远端对象与数据库元数据一致。受控远端故障注入验证重复/乱序 revision 4/3/4 不回退投影、未就绪 revision 5 连续 6 次失败后进入 DLQ，并确认故障前后 PostgreSQL/R2 的 revision、大小和 SHA-256 不变；临时 Worker 已删除且正式 Queue/DLQ 绑定已恢复。
- [x] 用户连接检查 `docs.read`/`docs.write`；Agent 连接检查 `document.read`/`document.edit` Grant 与 constraints。真实 smoke 使用项目管理员 Session 建立用户连接，并以临时 delegated Agent 的精确 Organization/Project/Document/字段/模式/action/有效期 Grant 完成读写；撤销 `document.edit` 会同步释放租约、恢复用户写入且拒绝 Agent 后续编辑，最终两个 Grant 与 Agent 均撤销。
- [x] Agent 只提交细粒度、带 base state vector/版本的操作，不提交无条件整篇覆盖。实现仅接受最多 10 个 `replace_block_content`，绑定当前 block opaque version、base revision/state vector、run ID 和 request ID；本地测试覆盖同块陈旧冲突和不同块合并，真实 smoke 通过该协议依次完成 collaborate/exclusive 并物化 revision 4，正文不进入审计。
- [x] 实现建议、协作和独占三种 Agent 编辑模式。真实 Agent Auth E2E 已验证 suggest 不写入、collaborate 写入，以及 exclusive acquire/renew/apply/release、5 秒超时接管、授权撤销释放、独占期用户写入阻断和撤销后恢复。
- [x] 测试单用户、单 Agent、用户+Agent、断网重连、冲突、checkpoint 恢复和权限撤销。Workers Runtime 覆盖建议/协作/独占、幂等、租约竞争/续期/释放/超时、同块冲突、不同块合并、用户写入拒绝、广播、审计、checkpoint/驱逐恢复和真实 Yjs 重同步；远端 smoke 覆盖用户+Agent、断线重连、独占写入阻断、Grant 撤销、用户恢复、Queue/R2/PostgreSQL 物化及自清理。

## M9：Agent 编排与执行环境

当前 M9 API 版本为 internal Worker `e45b9460-2435-4460-8c29-6178ea7d1caf`。固定 Document Agent Workflow `00000000-0000-4000-8000-000000000201` 已由受 Better Auth Agent Auth 保护的 Hono API 创建、查询和取消；Workflow 参数不包含 JWT、私钥、文档正文或完整 Grant，只保存精确 Grant ID、受限 scope 和结构化命令。`AgentCoordinator` 使用精确锁定的 `agents@0.22.0`，Agents SDK state 只包含有界 run 摘要。`task.execute` lease 核心现在允许 Cloudflare Agent 和本地 Codex、Claude Code、DeepSeek Harness 通过同一 Agent Auth 执行边界领取指定任务；PostgreSQL 是 lease/checkpoint/event 权威，通用 sandbox 继续延后到出现不可信代码、构建或 shell 需求时再选型。

- [x] 明确 AgentDO 只保存会话状态，不在 DO 内执行长时间推理。已部署 `AgentCoordinator`，SQLite 仅保存 Agent 绑定、run scope、状态/版本、幂等 transition 和安全错误码；不保存正文、JWT、Grant 内容、推理上下文或执行结果，不暴露公开 fetch/WebSocket 路由。
- [x] 用 Workflows 编排可恢复步骤、重试、超时与取消。Document Agent Workflow 使用版本化固定定义、确定性 transition ID 和 Cloudflare `terminate()`；取消不会回滚已提交的 Yjs/CRDT 变更，产品级补偿必须作为新的可审计文档操作，而不是伪造底层事务回滚。
- [x] 评估并选择执行环境。Cloudflare 托管路径采用 Agents SDK AgentDO + Workflows + Agent Tracing，本地 Codex、Claude Code、DeepSeek harness 使用本机执行环境和同一 Agent Auth/任务协议；当前任务编辑与文档操作不引入通用 sandbox。`@cloudflare/computer` 0.2.1 Worker backend 的 internal 部署因 experimental compatibility flag 被平台以错误 10021 拒绝，实验代码已移除。未来若需要不可信代码、构建或 shell，再在独立 Gateway 后重新评估 Computer、Sandbox SDK 或 Containers。
- [x] 完成 Cloudflare Agents SDK internal 垂直切片：既有 `AgentCoordinator` 已改为按 Better Auth Agent ID 稳定命名的 AgentDO，只镜像最近 run 的有界状态；未公开默认 `/agents/*` 路由；Worker traces 已启用，真实 Workflow run 已触发 Agent RPC/state 链路，payload 不进入 Agent state，PostgreSQL 审计继续作为权威。
- [x] 实现运行时无关的 `task.execute` lease 核心：命令覆盖 claim、renew、checkpoint、complete、fail、cancel_ack，Grant 精确绑定 Organization/Project/Task/execute/action/validUntil；可信 Agent/Host 来自 Agent Auth Session，PostgreSQL 强制同 Task 单 active lease、版本/checkpoint 单调、全局 request ID 幂等和事件审计。Cloudflare Agent、Codex、Claude Code、DeepSeek 共用 contract tests，真实 Codex Harness 完成远端全链路、稳定冲突码和 Grant 撤销拒绝。
- [ ] 补齐 Harness 调度面：运行时无关 `AgentTaskHarnessClient`、stdin JSON 本地 CLI 和基于精确 active Grant/实时 delegated 权限交集的可领取任务发现已完成；仍需 Host 心跳与受审批能力标签、基于标签的匹配及 Cloudflare 托管 adapter。不得让 Harness 自报标签扩大 Grant，也不得建立绕过 `task.execute` 的第二套入口。
- [x] AgentDO/Workflow 调用 DocumentParty 前验证 Agent Auth Grant 和 constraints。入口先验证 JWT 中的两个 capability，随后按精确 Grant ID 从 PostgreSQL 重查 active/expiry/constraints、文档真实 Organization/Project scope，并实时求 delegated 用户 `docs.write` 权限交集。
- [x] 所有可重试步骤使用业务幂等键，并把 run ID、actor、输入范围和结果写入审计。Coordinator 用 SHA-256 请求指纹拒绝同 run ID 的变更请求，Workflow transition 使用确定性 ID，DocumentParty 用 request ID 去重；审计不包含正文、JWT 或私钥。
- [ ] 完成长任务恢复、重复投递、取消、Harness 失联和权限中途撤销测试。当前本地运行时已覆盖 Workflow step 重试、Grant 拒绝和取消竞态；远程 Workflow smoke 覆盖成功、完全重复投递、变更请求冲突和 Grant 撤销，远程 Task Harness smoke 覆盖 claim/checkpoint 幂等、变更 request ID 冲突、竞争领取、checkpoint 跳号、完成和 Grant 撤销。仍需验证 lease 到期重领、Harness 失联、运行中人工取消与超长任务恢复。

## M10：API 与前端逐步切换

- [ ] 按领域模块建立 Go API → Hono Worker 的迁移清单和依赖图。
- [ ] 优先迁移认证、只读查询和边界清晰的新功能，再迁移复杂事务模块。
- [ ] 每个迁移模块运行新旧 API contract tests 和数据一致性验证。
- [x] React Web 保留 TanStack Router/Query/Form；首个认证与首页读取切片已切换，其余领域模块继续逐模块迁移 API client 与 cache invalidation。
- [x] internal preview 已由同一 Worker origin 提供 React Static Assets 与 `/api/*`，并以 SPA fallback 处理前端路由、Worker-first 处理 API/health/internal/ws 路由；若未来拆分 Pages/API 域名，仍必须使用同站点自定义域名、精确 CORS 和 credentials，不依赖跨站第三方 Cookie。
- [x] 为尚未迁移的首页读取请求提供受 Session 保护的只读空工作区投影，并明确标记为临时桥接；不得据此宣称 Project、Task 或 Permission 领域已完成迁移。
- [x] 将项目基础 API 从空投影替换为真实 PostgreSQL repository：列表、统计、创建、读取、更新、归档均由 Organization/Project 权限边界保护；internal preview 项目页只展示该切片能保证的数据。
- [x] 将项目角色与人类成员 API 迁移到 Worker：角色和成员变更由 Project 权限边界、服务端 grant ceiling、数据库约束与同事务保护共同执行；Team/Settings 仅开放已迁移能力，Agent 成员等待 Agent Auth。
- [x] 将 Organization 动态角色与成员角色分配 API 迁移到 Worker：成员生命周期不另建第二套表，Paca 角色可多选，权限上限、大小写无关唯一约束、内置角色和最后一名 OWNER 在服务端与事务边界内保护；internal preview 仅开放真实可用的组织权限页面。
- [x] 将 Task API 迁移到 Worker 的基础、详情、活动、父子层级与关联关系切片：默认类型/状态随项目事务创建，任务列表/搜索/创建/读取/更新/软删除通过 Project `tasks.read`/`tasks.write` 授权，支持项目内递增编号、类型、状态、日期、标签、描述、故事点、多 Assignee、`parent_task_id` 与独立 Task Link；父级写入阻止循环/跨项目/归档目标，关联写入阻止自关联、跨项目和对称重复。任务写入、关系变更与可信动态原子提交，评论按 Better Auth 用户身份限制作者编辑/删除。internal preview 已开放真实列表和详情页，并恢复父级选择、子工作项与关联工作项 UI。
- [x] 将 Sprint、任务视图、手工任务位置、自定义字段和高级 Task 查询迁移到 Worker：Sprint 完成时在同一事务移动未完成任务，视图保持 Project/Sprint 真实作用域及最后视图保护，自定义字段在任务写入时按服务端定义验证；Task 查询支持现有 `InteractionLayout` 所需的筛选、排序、游标、汇总和手工位置契约。internal preview 已恢复完整 Board/Table/Roadmap UI，任务详情仍使用已迁移的安全页面。
- [ ] 为 Worker/Go API 混合期定义明确路由、超时、错误格式和回滚开关。
- [ ] 记录确认长期保留在容器中的模块及原因，不以“暂未迁移”作为永久设计。

## M11：旧实时与 Valkey 退役

- [ ] PartyServer/Queues/Workflows 覆盖全部仍需要的 Socket.IO 与 Valkey Pub/Sub/Streams 行为。
- [ ] 完成并发、可靠事件、重连、顺序、重复投递和故障恢复压测。
- [ ] 停止新写入后观察一个完整回滚窗口。
- [ ] 移除 Socket.IO、对应 Valkey Pub/Sub/Streams 和无用部署配置。
- [ ] 保留仍有明确用途的缓存能力；不得为了“完全 Cloudflare”删除必要缓存。

## M12：D1 独立实验路线

- [ ] 建立独立 SQLite/D1 schema、migration 和 repository adapter，不复用 PostgreSQL SQL。
- [ ] 实现 UUID、JSON、FTS5、事务/batch、并发和 read replication Sessions 适配。
- [ ] 对 PostgreSQL 与 D1 运行同一组 repository contract tests。
- [ ] 验证 Better Auth Core、`pacaPermission` 和 Agent Auth 在 D1 adapter 下的完整语义。
- [ ] 明确不支持或需要降级的 PostgreSQL 专有能力。
- [ ] 只有通过功能、并发、恢复和权限测试的模块才能声明支持 D1。

## 跨阶段质量门槛

- [x] Worker 类型、Drizzle migration、TypeScript、Biome、单元测试、React internal build 和 dry-run bundle 已进入 PR CI；通用数据库集成与可重复浏览器 E2E 基础设施待补。
- [x] 首个部署版已完成人工浏览器渲染验收和无凭据输出的远端认证/工作区 API 全链路烟测。
- [x] 已加入不会输出凭据的 `smoke:internal` 验收脚本，覆盖 public health、Hyperdrive health、注册/登录、Session、登出和旧 Cookie 撤销。
- [x] 已运行 Worker 本地启动剖析：bundle gzip 约 391 KiB，本机 sampled active CPU 约 30 ms；profile 临时文件已清理。
- [ ] PostgreSQL migration、权限 decision、Agent Grant、Queue 幂等和 Yjs 恢复具有独立测试套件。
- [ ] 预览与生产使用隔离的数据库 branch、R2 bucket、Secrets 和 Durable Object namespace。
- [ ] 日志统一包含 request ID；Agent/Workflow/文档操作包含 run ID 和可信 actor。
- [ ] 建立 Worker、Hyperdrive、DO、Queues、Workflows、R2 和数据库可观测性。
- [ ] 建立数据库恢复、权限误配、Agent Grant 泄露、DO 状态损坏和队列积压的运行手册。
- [ ] 每次切流前记录回滚负责人、命令、数据兼容窗口和停止条件。

## 当前代码落点

- `services/api/migrations`：现有 PostgreSQL schema/migration 基线。
- `services/api/internal/repository/postgres`：现有 PostgreSQL repository 和方言行为基线。
- `services/api/internal/platform/authz/permissions.go`：现有稳定权限词汇迁移基线。
- `services/api/internal/platform/authz/authorizer.go`：旧权限聚合与 wildcard 行为，供 shadow comparison 使用，切换后删除。
- `services/api/internal/repository/postgres/document_repository.go`：现有文档 JSON 与快照语义基线。
- `services/worker-api/src/document`：DocumentParty/YServer、DO SQLite 增量/checkpoint、原子 bootstrap、修订/Queue/Alarm、R2 快照与 BlockNote 业务投影物化、短期连接上下文、PostgreSQL 文档 CRUD/作用域查询与用户/Agent 实时鉴权。
- `services/worker-api/drizzle/0016_busy_changeling.sql` 与 `0017_last_toro.sql`：待应用的 PostgreSQL 文档业务投影、项目实时 outbox 触发器、Yjs 修订/R2 快照元数据与版本化 checksum。
- `services/realtime/src/server.ts`：现有 Socket.IO 鉴权、Project/User room 行为基线。
- `services/realtime/src/subscriber.ts`：现有 Valkey Pub/Sub 事件路由基线。
- `apps/web`：现有 React 与 TanStack Router/Query/Form 前端；文档编辑器已加入 BlockNote + `y-partyserver/provider` 的本地候选实现。
- `services/worker-api`：Hono Worker、Hyperdrive runtime 数据访问、Drizzle schema/migration 与 Better Auth 的目标代码路径。
- `services/worker-api/src/realtime`：ProjectParty/UserParty、Hibernation、可信连接 attachment、事件过滤、PostgreSQL outbox、Queue consumer、DO 幂等投递和 Worker 路由。
- `apps/web/src/components/projects/docs/collaborative-doc-editor.tsx`：旧 BlockNote JSON → Yjs 原子初始化、同源 PartySocket 连接、Awareness 和只读失败降级。
