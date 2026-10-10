# Paca Cloudflare 重构工程进度

本文件是 Cloudflare 重构的唯一工程进度清单。目标架构和不可违反的约束以根目录 [`AGENTS.md`](./AGENTS.md) 为准；这里只记录当前状态、剩余工作和验收条件。

## 使用规则

- `[ ]` 表示未完成；`[x]` 表示代码、测试、迁移和必要文档已达到当前阶段验收条件。
- 已完成内容按能力合并记录，不保留逐次部署版本号、临时测试数据、测试数量或重复烟测流水。
- 数据库重建、远端部署、Secret 修改和删除旧服务属于外部状态变更，必须确认目标环境并保留可重放的 schema 与部署版本；当前不保留 legacy 数据回滚路径。
- 不在日志、提交或本文档中记录数据库连接串、Better Auth Secret、Agent 私钥等凭据。
- PostgreSQL 是默认主线；D1 是独立实验路线，不阻塞默认主线。

## 当前状态

更新时间：2026-10-10

当前可用基线：**M1～M9 的核心路径已形成 internal 纵向切片；六类任务事件、到期、Cron 和四类 Sprint 自动化触发器及正文检索已部署 internal；调度与 Sprint 仍待真实事件/浏览器验收。当前优先完成本地 Agent 接入和 GitHub 交付验收，同时完成权限单权威切换、Automation/Agent Conversation 剩余能力及正式上线验收。**

- internal 入口为 `https://paca.howlearnwood.com`，React Static Assets、Hono API、Better Auth、Hyperdrive、R2、PartyServer/DO、Queues、Workflows、Agents SDK 与 Cloudflare Sandbox 已连通。
- `paca/internal` 已通过 clean-slate 工具从空 schema 重放，并继续应用至 `0039`；迁移 ledger 与最小 runtime role 权限验证通过，legacy attachment migration 账本和 `legacy-agent-runner` Environment backend 已删除。`paca/main` 仍停在 `0014`。internal Worker runtime role 不可访问迁移账本。
- Agent Auth 的用户审批、Agent/Host、受约束 Grant、任务/文档/环境执行、审计和撤销边界已可用；`capability.executed` 以真实 Agent 为 actor，delegated 用户仅保留为委托上下文。
- PostgreSQL 测试流程已能从空库应用至 `0039`，并覆盖 migration ledger、clean-slate schema、前滚恢复演练和 repository contract。
- Worker 业务路由权限边界、Go legacy JWT role 移除、Agent Runner 单 Agent 身份隔离及 legacy Environment backend 删除均已通过 CI；已落地提交已同步至远端 `master`。
- 当前仍处于未上线开发期，用户已明确允许清空并重建数据；不迁移 legacy User/密码/Session/JWT、旧附件或其他历史业务数据。Better Auth 与 Worker schema 是新环境唯一基线。新增任务字段/前置任务事件和可靠调度已部署，线上 Automation 图 CRUD、任务事件→条件/动作/等待→Run/步骤记录的 smoke 通过；这不代替四类新增任务事件、到期、Cron、Sprint 和浏览器的逐项验收。完整动作、Webhook 与远端调度验收仍未完成。

### 本阶段收尾与交接

- [x] Automation 任务字段和前置任务触发器代码、迁移、契约测试及文档已提交并同步至远端 `master`；internal 数据库已应用对应 migration，当前 Worker 已包含这些触发器。
- [x] 2026-10-10 恢复 Cloudflare 与 PlanetScale CLI 授权；Wrangler `paca` OAuth profile 绑定项目根目录，Worker API/Environment Gateway 固定 Paca account ID，两处只读部署记录验证通过。凭据由 Wrangler 本机保存，不进入仓库。
- [x] 当前改动已部署 internal，健康检查和真实 Automation 图 CRUD/条件/动作/Workflow Run smoke 通过。
- [ ] 以真实任务事件验收四类新增触发器和受限图前端入口。
- [x] `due_date_reached` 的可靠调度代码、本地迁移及契约验收已完成：UTC 日期/有界分钟偏移、数据库唯一调度键、独立 outbox、消费复查、延期/重试/停用/多节点与并发扫描。已部署 internal，真实事件验收仍待完成。
- [x] Automation 可靠 `cron` 与 Sprint 事件触发器已完成本地实现及契约验收；保持激活白名单只包含已实现并验证的执行器。
- [ ] Sprint 动作收尾真实浏览器验收，后续编码节点为 Agent 动作、Call API/Webhook，随后完成完整浏览器契约。

### 本轮实施：到期事件可靠调度

- 最小交付物：`due_date_reached` 严格配置校验、UTC 日期/分钟偏移契约、有界到期扫描、数据库唯一调度键与持久 outbox、消费时日期/图版本复查，以及前端节点入口与偏移输入校验。
- 验证命令：Worker `db:check`、`typecheck`、`lint`、`test`、`test:postgres`，Web `test` 与 internal build；部署权限恢复后执行 internal 真实事件和浏览器验收。
- 回滚路径：先停用到期图并等待已接受的到期 Run 完成，再回滚至已验证 Worker；保留 additive migration 和调度去重记录，不执行破坏性 down migration。
- [x] 实现并完成本地到期调度及延期、并发扫描、重投、停用、多触发节点和 UTC 边界契约验收。`0035_cold_steve_rogers` 在独立本地 `_test` 库重放，Drizzle 检查、Worker 类型/lint/回归、PostgreSQL 契约和迁移恢复、Web 回归/internal build、Workers 运行时、binding types 与部署 dry-run 均通过。
- [x] 修复分钟维护失败互相阻塞与 Automation producer 晚到覆写 delivered 状态的竞态；故障隔离与实际数据库交错写入契约通过。到期输入拒绝空值、小数、越界，所有支持语言明确 UTC 及补触发语义。
- [x] internal 已应用 `0035`/`0036`/`0037`，迁移 ledger、runtime role 权限验证及临时迁移身份回收完成；本地迁移恢复演练再次通过。
- [x] internal Worker 已部署，原 Cloudflare `10000` 授权阻塞已解除。
- [ ] 真实到期事件与浏览器验收。

### 本轮实施：周期调度与 Sprint 事件

- 最小交付物：UTC 五段 Cron 校验、持久调度游标与有界扫描/遗漏合并、图版本及 occurrence 幂等 outbox；Sprint 生命周期同事务事件与无 Task 的真实运行上下文，条件和显式任务目标契约，以及前端可执行节点入口。
- 验证命令：Worker `db:check`、`typecheck`、`lint`、`test`、`test:postgres`、`test:workers`、binding types/deploy dry-run；Web 回归与 internal build；权限恢复后执行真实事件/浏览器验收。
- 回滚路径：先停用周期/Sprint 图并等待已接受的新类型 Run 完成，再回滚 Worker，保留 additive migration、outbox 与调度游标；不复用旧 Valkey scheduler、不执行破坏性 down migration。
- [x] `0036` 版本化迁移、UTC 五字段 Cron 和索引游标、遗漏周期合并补执行、并发锁及 occurrence 幂等事件已完成；Sprint 生命周期同事务捕获、筛选与删除快照已完成。空库重放、PostgreSQL 事务/并发/项目隔离/无任务上下文契约和迁移恢复通过。
- [x] Workflow 支持没有基础 Task 的等待、Sprint 条件与显式其他任务目标；激活和执行时拒绝缺少基础任务的相对目标。正式 Workflow 的 Workers 运行时编排测试通过，数据库步骤由官方 introspector 替换，SQL 行为由真实 PostgreSQL 契约验证。
- [x] 前端启用已验收节点，校验 Cron 并显示本地化输入错误，补齐 Sprint 筛选、删除提示和加载重试；修正无 Task 连线、前置任务必填及数量限制，并允许清除已删除的监听项。Worker 类型/lint/完整回归、Web 完整回归与最终类型/internal build、binding types 与部署 dry-run 通过。
- [x] 两类调度每分钟各捕获至多 50 项，合计匹配单批 100 项 outbox 派发上限；故障隔离与延期恢复仍保持独立可靠。
- [x] internal 数据库已应用 `0036`。
- [x] internal Worker 已部署 Cron/Sprint 事件支持。
- [ ] 真实事件与浏览器验收。

### 本轮实施：Sprint 自动化动作

- 最小交付物：`update_sprint` 和 `complete_sprint` 的严格配置、真实 Sprint 目标解析、复用迭代领域校验和完成时任务流转、同事务 Run 步骤/业务审计/事件，以及前端已验收入口与输入反馈。
- 验证命令：Worker 类型/lint/回归、PostgreSQL 事务/幂等/作用域/任务流转契约、Workers 编排；Web 类型/回归/internal build 和部署预检。
- 回滚路径：先停用相关图并等待已接受的新动作 Run 完成，再回滚 Worker；保留数据库事件和 Run 审计，不回退至 legacy 执行器。
- [x] Sprint 动作实现及完整本地验收：严格字段与日期配置、空字段清除、目标持久化、冻结 Run 配置、同事务业务写入/步骤与审计、未完成任务迁移、重复完成 no-op、权限作用域和归档/删除拒绝；修复用户完成 Sprint 时 Drizzle insert-select 缺少默认列的真实数据库错误。前端输入反馈、目的 Sprint 加载重试与失效目标保护、九种语言、完整回归和类型/lint/build，真实 PostgreSQL 并发/回滚/用户审计与 Workers 编排及部署预检通过。
- [x] internal Worker 已部署 Sprint 动作，真实 `sprint_started` 事件→更新目标与清除日期→完成迭代→未完成任务迁移及 Done 任务保留、两步记录和 system 审计验收通过；同轮任务条件、扇出及 wait 链路通过，临时资源和数据库角色清理完成。
- [ ] Sprint 动作真实浏览器输入、保存与运行详情验收。

### internal 首位用户初始化验收

- [x] 用户已自行设置密码并登录；数据库确认密码账户和活动 Session 存在，不读取或缓存密码、Cookie 或 Session token。
- [x] 修正并发 smoke 注册占用首位管理员名额的问题：测试账号清理后，在唯一真实用户、无既有管理员、原角色为默认 MEMBER/USER 的事务守卫下恢复首位用户的 SUPER_ADMIN、Organization OWNER 和 owner 成员角色；专用短期数据库角色已清理，当前没有正式项目。
- [x] Automation smoke 增加真实管理员初始化前置检查、临时账号权限最小化及 CLI/HTTP/数据库超时；防止空实例测试账号再次占用管理员名额。
- [ ] 用户首页创建正式项目、项目权限和设置导航的真实浏览器验收；其余 smoke 的首次注册前置检查统一补齐。

### 当前优先顺序

1. 本地 Agent 接入：完成 Codex/Claude Code Host/Agent 注册审批、连接诊断、真实工作目录、心跳、任务领取/续租/检查点/取消与交付；保留本机工具授权，Agent Auth 是唯一身份边界。
2. 正文检索：任务描述与文档正文的项目内关键词搜索、摘要和游标分页；同一 API 服务浏览器与受约束 Agent/MCP，未获授权内容不可进入结果。
3. GitHub 交付验收：绑定项目仓库及任务 Run 的固定 Commit/PR，验证真实 CI/评审证据并由用户验收；区分执行完成与交付通过。
4. 完成 Better Auth/`pacaPermission` 单权威切换、Automation/Agent Conversation 剩余能力、Runner 正式部署和 legacy 退出；已有未完成改动先修至可验证基线。
5. 完成 Environment、BlockNote、Sprint/Custom Field/View 的真实浏览器验收，以及个人筛选、搜索分页、并发更新和错误恢复体验。
6. 完成生产资源隔离、部署权限、可观测性、恢复/回滚演练及真实开发任务端到端验收后，才声明正式可用。

### 本轮实施：生产隔离与发布门槛

- 用户已确认正式入口保留 `paca.howlearnwood.com`，internal 入口迁至 `paca-internal.howlearnwood.com`；迁移入口须在候选环境验收后执行。
- 最小交付物：独立生产 Worker/Gateway、数据库 runtime role 与 Hyperdrive、R2、Queues/DLQ、Workflow/DO、Secrets 和严格同源认证配置；生产注册关闭、首次管理员初始化路径及可重复发布守卫。development 默认配置不得连接生产数据库。
- 验证命令：配置隔离/错误注入契约、认证协议（关闭注册仍可登录）、Worker/Gateway 类型/lint/回归、types 检查、生产 dry-run、数据库空基线/runtime 权限验收及候选部署健康/同源 smoke；生产切流前补齐完整用户/Agent/交付页面验收。
- 回滚路径：候选部署失败仅回滚生产候选版本，保持现有 internal 入口及新用户数据；入口切换时记录两个 Worker 版本和域名归属，失败恢复原入口，停止新任务领取，不复用 internal 凭据或恢复 legacy 身份。
- [x] 生产候选配置与发布守卫：独立 Worker/Gateway、Hyperdrive/R2/Queue/Workflow/DO 命名，候选无公网路由；24 类误配注入契约和候选/切流双阶段检查通过。默认 development 改为本地 Hyperdrive 占位，并以真实本地 Worker `/health` 200 验证，可避免误连生产。
- [x] 生产认证与安全初始化契约：关闭公网注册，首位 Owner 使用本机一次性页面及 Better Auth/`pacaPermission` 规范流程；真实 PostgreSQL 验证失败回滚、拒绝重复创建、密码可正常登录及临时 Session 撤销。本机页面校验精确 Origin/Host、邮箱、密码确认、大小/方法边界、并发和到期关闭。
- 本轮交付：生产初始化工具固定未发布的 `main` 分支，核验 Cloudflare 旧数据库消费者、最新备份和 migration 基线，使用短期 operator role 与 TLS PG Client 重建/授予显式 runtime 权限；管理员通过仅绑定本机的短时一次性页面自行设置密码，沿用 Better Auth 与 Paca Permission 首位 Owner 语义，拒绝重复初始化。验证错误目标/备份/已发布环境、真实 PostgreSQL 权限与 Owner/Session 清理、schema 恢复及本机页面输入边界。失败停止生产发布，不改 internal 数据；凭据不进命令参数或日志。
- [x] 前端 Cloudflare runtime 与内部注册开关分离：两类 Cloudflare 构建明确选择 `VITE_PACA_RUNTIME=cloudflare`，生产禁用测试注册仍保留 GitHub 设置等原生入口；前端 674 项测试及生产构建通过。
- [ ] 独立数据库/Hyperdrive/R2/Queue/Workflow/DO/Secret 实际验收。
- 2026-10-10 资源准备：已创建生产文档快照桶及 3 个源队列/3 个 DLQ，复用既有生产附件桶；新建非继承的 `paca-worker-production` 角色和 Hyperdrive `98086061f9064f6c8f815303002c4a88`（连接上限 5、禁用查询缓存、TLS require）。该角色已应用并验证显式 runtime grants；候选部署已进行，不能视为生产验收完成。
- 2026-10-10 生产数据库初始化：全账户 Worker settings 盘点确认旧 main/new production Hyperdrive 均无部署消费者，域名仍由 internal 持有。初始化前备份 `irq17lr8vbcl` 已成功；旧宽权限角色已删除，`main` 在单一事务内完成 clean-slate 重建及 40 份 migration，初始账号数为 0。migration operator role 已转交对象所有权并删除；未复制或清空当前 internal 工作区。
- 修复 runtime 权限检查的 OR 漏检：逐表逐 action 校验全部 CRUD，并拒绝 schema CREATE、migration ledger、宽权限角色成员关系及数据库/角色管理权限；真实 PostgreSQL 覆盖分别撤销 CRUD 权限的失败路径。
- 远端数据库验收：生产 59 张表/40 份 migration/0 账号/0 Session，全部 public 对象稳定归属 `postgres`；runtime 权限及旧宽权限/initializer 角色清理验证通过。internal 保留既有人类账号和 1 个 Session，40 份 migration，未创建正式项目。
- 供应商恢复演练：将备份 `irq17lr8vbcl` 恢复到独立 `paca-recovery-20261010`（PS-DEV）并验证 39 表、15 份完整 migration、3 账号/3 credential account/4 Session 与源快照一致；只读验证角色已删除，临时恢复分支随后清理。没有将旧账号复制回当前 production/internal。
- 2026-10-10 首位生产管理员已由用户自行设置密码并完成创建；远端复核 1 账号、`SUPER_ADMIN`/Organization `OWNER`/member `owner`，bootstrap Session 为 0，短期 Owner/operator 角色已删除。公网注册仍关闭，当前域名和 internal 登录保持可用。
- 本轮验证：Worker 643 项单元测试、66 项真实 PostgreSQL 契约及 40 份 migration 重放/事务回滚/前滚恢复通过；新增初始化目标/备份/已部署拒绝、本机页面边界与 Owner 原子性测试通过，typecheck/lint 通过。独立恢复分支与验证角色已实际删除；首位生产账号已由用户完成。
- GitHub App 环境隔离工具：production 使用独立私有配置与名称，只暂存本机，不提前创建 Worker/写 Secret；已启动生产 manifest 页面，待用户完成独立 App 创建/安装。internal App 单仓库只读权限、签名 ping 及当前 webhook 配置已再次验证。安装验证显式区分 `signedWebhook: not_checked`；切流工具先核验目标环境、固定 PATCH hook URL 并 GET 回读，拒绝跨域/重定向/超大响应，不打印凭据。
- 发布守卫补齐版本预览入口：development/production Worker 与 Gateway 显式 `preview_urls=false`，防止仅关闭 workers.dev 仍暴露预览 URL；候选隔离守卫 28 项测试通过。Worker 657 项单元测试、Gateway 33 项测试和两个生产 dry-run 通过；生产 API 运行/浏览器/实际 Webhook 验收仍待候选 smoke 和切流后完成。
- 2026-10-10 生产 Gateway 候选实际部署：`cc2f289f-e96b-4cf9-8fcd-fd554b6f4692`，新独立 ticket Secret 随代码上传，临时 Secret 文件已删除；5 个 DO namespace 均不复用 internal，Container application `a03d9fcf-4db0-41f2-b79a-00935c4514a9` 从 0 实例启动、上限 5。远端 settings/subdomain/domain 复核无公网域名，`enabled=false`/`previews_enabled=false`；环境实际连接与恢复仍待候选端到端验收。
- 2026-10-10 生产 API 候选实际部署：`6f8e9509-46df-4012-b49c-dcd2a3a76eee`，生产静态资源、独立 Better Auth/health Secret、4 个独立 DO namespace、2 个 Workflow 和 3 个队列 producer/consumer 已部署；Hyperdrive 和 Gateway Service Binding 指向各自 production 资源，临时 Secret 文件已删除。远端 settings/subdomain/domain 验证 production 无公网和预览入口，两个当前域名仍由 internal 持有。生产 GitHub App 凭据尚未接入；未把部署成功当成完整验收。
- 验证：Worker 637 项单元测试、64 项真实 PostgreSQL 契约、40 份 migration 空库重放与回滚/前滚演练通过，33 项 Workers runtime 契约通过；Gateway 33 项测试通过；两个环境 types 检查和生产 dry-run 通过。上述 dry-run 不代表远端资源、Secret 或浏览器验收完成。
- internal 已部署修复，版本 `4597ee81-0553-4a30-86cc-95d5d8f13a64`；在线 `/health`、首页和 Agent discovery 为 200，匿名 `/api/me` 为 401。内置浏览器仍仅能列出现有 `/home` 标签，正文读取再次超时，未把 HTTP 检查算作真实页面验收。
- [ ] internal 域名迁移、生产切流与正式上线验收。

### 优先实施：本地 Agent 接入

- 最小交付物：私有配置与单 Agent 身份校验、可操作的本地连接诊断；Codex/Claude Code Harness 在真实工作目录连接 Agent Auth、受约束 MCP 和任务 lease；心跳、续租、检查点、中断恢复、取消及授权撤销贯穿执行。
- 验收：新机器按文档接入后可发现获准任务并完成一项真实开发任务；同一任务无重复 active lease，网络失败和撤销会停止推进，进程日志不含私钥/JWT/Grant，工具权限仍由本机用户控制。
- 验证命令：MCP `npm run build`、`npm test`；Worker `typecheck`、`test`、`test:postgres`；bridge/Runner Go 单元与 race 测试；internal 真实 Host/Agent/MCP/lease 验收。
- 回滚路径：停止领取新任务，取消或等待现有 lease 收尾，撤销对应 Agent Grant，回滚已验证客户端/Worker；不恢复 legacy Agent API Key。
- [x] MCP `--doctor` 只读诊断、0600 私有配置/单 Agent 身份/认证模式隔离、授权状态与项目范围摘要及安全错误提示；本地 build 和完整测试通过。
- [x] 原生 MCP `execute_task_lease` 接入受约束任务执行协议；固定本地 Harness、具体 Task/action/有效期、心跳和幂等请求，Sandbox Broker 不开放该能力；本地 build 和完整 MCP 测试通过。
- [x] 修复用户取消后拒绝 Agent `cancel_ack` 的状态机问题；确认保留原取消时间/原因/租约有效期，且拒绝续租、检查点和结果提交。PostgreSQL 并发重试、身份/作用域和其他终态契约通过，已部署 internal。
- [x] internal 临时 Host/Agent 的注册审批、独立调度标签审批、连接诊断、真实 MCP stdio 搜索/任务发现/领取/幂等重试/续租/检查点/提交，以及断线恢复、用户取消确认和 Grant 撤销均通过；临时身份撤销、测试数据和本地私有配置清理完成。
- [ ] 完整真实用户接入体验；旧测试身份返回 401，需要真实用户新审批并在真实工作目录完成 Codex/Claude Code 开发任务，不回退 API Key。
- [ ] 真实 Codex/Claude Code 任务执行、恢复、取消和撤销验收。

### 优先实施：正文检索

- 最小交付物：任务标题/编号/描述、文档标题/正文的字面关键词检索，返回稳定 ID、匹配片段、来源与有界游标；浏览器入口及 Agent Auth MCP `search_tasks`/`search_docs`，查询始终受项目及具体 Grant 约束。
- 验收：中文、格式化文本、嵌套 BlockNote、百分号/下划线等字面字符，空结果、分页、已删除记录、项目隔离及撤销均符合契约；不把 JSON 结构键、任意属性、secret 或全文无界返回给调用方。
- 验证命令：Worker 类型/lint/单元、真实 PostgreSQL contract；MCP build/test；Web 类型、检索交互测试与 internal build；真实浏览器及本地 Agent 检索验收。
- 回滚路径：关闭新检索入口，回滚 Worker/MCP；保留 additive schema/index，不绕过权限退回全量下载。
- [x] 领域接口、PostgreSQL generated body/pg_trgm 索引、用户 HTTP 和受约束 Agent/MCP 检索；中文/嵌套正文、字面通配字符、删除/项目隔离、精确时间游标与分页、授权边界及 5000 文档规模契约通过，`0037` 已应用 internal。
- [x] 浏览器搜索入口、类型切换、文本摘要、游标加载、空结果/错误重试和九种语言反馈；本地交互测试、完整 Web 回归及 internal build 通过。
- [x] 已部署 internal 并通过真实用户中文正文/字面字符/游标分页/未登录拒绝、Agent 精确任务与文档 Grant/撤销、MCP stdio 和删除文档隐藏验收；临时测试资源已清理。
- [ ] 完成真实浏览器检索交互与真实 Codex/Claude 开发任务中的按需检索验收。

### 优先实施：GitHub 交付验收

- 最小交付物：项目仓库绑定、Run/Task 的 PR 与 Commit SHA 关联、GitHub 来源的 CI/评审证据、等待验收/通过/需修改状态和可信用户验收审计；GitHub App/凭据及 webhook 采用最小权限、签名验证和投递幂等。
- 验收：拒绝其他仓库/任务的证据；PR 新 Commit 使旧验收失效，陈旧/未知/失败的 CI 不能通过门禁；Agent 自报完成不等于验收通过；用户失权后不能验收；Webhook 重投不重复推进任务，不自动合并或发布代码。
- 验证命令：Worker 领域/HTTP/真实 PostgreSQL contract、GitHub 固定 payload 与 HTTP fixtures、Web 状态/验收交互及 build；internal 真实 PR→CI→人工验收链路。
- 回滚路径：停用 GitHub 事件消费和新验收写入，保留交付证据/审计，回滚已验证版本；不把未知状态标为通过。
- [x] 只读 GitHub 证据协议/采集器与诊断 CLI：固定仓库/PR/head SHA、可信 Check App/评审用户、重检 head、分页及响应上限、安全错误、证据时效；在上游真实 PR #557 的固定提交上读取 E2E CI 成功。此检查仅产生等待人工验收的证据，不写任务验收。
- [x] 持久项目仓库/已完成 Task Lease/固定 PR 与 SHA 关联、策略及交付版本 CAS、幂等决定与审计；Hono 用户 Session 权限边界和外部查询后权限复查，仓库配置另需实例管理权限。领域/HTTP/真实 PostgreSQL contract 已验证，数据库表已应用 internal。
- [x] GitHub App 短期 JWT 与单仓库只读 installation token 适配；原始 bytes HMAC-SHA256 Webhook 校验、事务回执与证据失效、安装撤销、回执有界清理；本地/Workers runtime 已验证。
- [x] 服务端人工接受/要求修改、失效与历史状态：接受前重新取证，保留人工要求修改，拒绝过期或未知证据，不自动关闭任务。
- [x] 专用私有只读 GitHub App `paca-yudi-delivery` 已创建，安装事件确认仅选择 `yudi-xiao/paca`；internal 三项 Secret 已配置，单仓库访问与签名 ping 验证通过，真实安装事件及首次 ping 重投均收到成功响应。本地 manifest 引导与私有凭据恢复流程已验证，临时创建页面已关闭。
- [x] 任务交付卡片与受权限保护的已完成运行选择：固定 PR/SHA、CI 状态、证据时效、人工验收/修改说明、版本冲突和不确定网络结果的同请求重试；九种语言及交互、权限隔离和真实 PostgreSQL 分页已验证。
- [x] 项目仓库配置页面与只读发现 API：从真实 PR 选择 CI 名称/可信发布方、核验评审者 ID、保存不可变仓库/安装 ID；权限复查、策略版本冲突及不确定结果的同请求重试、设置直达和九种语言已覆盖。专用 App 的真实单仓库发现通过；页面交互和导航契约已验证。
- [x] 仓库发现/保存已部署并完成真实 internal Session→权限→GitHub→数据库验收，覆盖重放、版本冲突和撤权，临时资源已清理；已修复 Workers 不支持的重定向模式，并补原生 Request/拒绝 302 回归和不含凭据的失败诊断。保留有显式 internal 确认串的可重复 smoke 命令。
- [ ] 仓库配置和交付页面的真实浏览器体验及 PR→CI→人工验收完整链路。
- [x] 已发布 [Draft PR #1](https://github.com/yudi-xiao/paca/pull/1)，GitHub CLI 登录恢复；首轮 Web/MCP/Worker CI 全部通过，Worker CI 包含运行时及真实 PostgreSQL 契约。只读 App 确认三项 CI 属于固定提交，Draft 状态仍阻止验收；真实 PR/Check 事件投递成功。后续变更继续随 PR 验证。

### 已纳入计划的上游功能（2026-10-10）

对比来源：`Paca-AI/paca`，最新正式发布 [`v0.18.6`](https://github.com/Paca-AI/paca/releases/tag/v0.18.6)（2026-10-06）；同时核对截至 2026-10-09 的 `master`，固定提交 [`09c3f873f594d1857afd16bc9a173317d9502f44`](https://github.com/Paca-AI/paca/commit/09c3f873f594d1857afd16bc9a173317d9502f44)。本地代码、未提交改动、Worker migration manifest 和前端 internal 入口分别检查；保留 legacy 文件或页面不代表新环境可用。

用户已确认将以下功能纳入正式计划。本地 Agent、正文检索和 GitHub 交付验收优先，其余按依赖分阶段交付；未勾选项不代表已实现，也不要求全部成为首发阻塞。进入各阶段前须补充最小交付物、验证命令和回滚路径。

| 上游能力及证据 | 当前 Cloudflare 落点 | 对 Agent First 流程的建议 |
| --- | --- | --- |
| 本地 [ACP bridge](https://github.com/Paca-AI/paca/blob/09c3f873f594d1857afd16bc9a173317d9502f44/apps/acp-bridge/README.md)、`provider_cli` 和 [Paca Skills](https://github.com/Paca-AI/paca/blob/09c3f873f594d1857afd16bc9a173317d9502f44/docs/guides/install-skills.md) | 有 bridge/MCP/Runner 代码及新 Harness 协议，但 Agent Conversation、Skills 和 Runner 正式部署尚未完整验收 | 优先完成本地 Agent 接入和连接诊断，让现有 Codex/Claude 工作目录参与执行；保留本地工具授权，以 Agent Auth 替换旧 bridge/API Key 身份，不能直接沿用上游自动批准所有本机工具的行为 |
| [正文搜索与 MCP `search_docs`/`search_tasks`，#531](https://github.com/Paca-AI/paca/pull/531) | Worker 任务查询已有标题/编号搜索；未发现对应正文搜索 API 和新 MCP 工具 | 高价值增量：返回项目内匹配片段、文档路径、稳定 ID 和游标，供 Agent 按需读取；当前上游为关键词匹配，不能宣传成语义搜索 |
| [Jev 自动补字段、自动分派、AI 条件，#510](https://github.com/Paca-AI/paca/pull/510) | Worker 未实现这组功能 | 基础执行链稳定后增补；仅补空字段、不覆盖人工输入，低置信度转人工/Else；候选 Agent 必须先通过真实 Grant、在线状态及 Harness 能力过滤，模型选择不能扩大授权；隔离决策 provider |
| [预览页面标注转任务](https://github.com/Paca-AI/paca/blob/09c3f873f594d1857afd16bc9a173317d9502f44/apps/extension/README.md) | 未迁移 extension/annotation API，Environment 预览契约未完成 | 适合“指出界面问题→Agent 修复→重新验收”；依赖预览访问边界，重设计 Better Auth 授权，不能复制 legacy Cookie/跨 scheme 登录方案 |
| [统一项目活动页，v0.18.0](https://github.com/Paca-AI/paca/releases/tag/v0.18.0)、活动 diff/revert | 已有任务活动、Agent 及 Workflow 审计；未形成统一项目活动和一般字段撤销入口 | 聚合任务、文档、运行与交付证据，支持人工接管；字段撤销必须检测当前版本并形成新审计，不能覆盖其他人后续修改 |
| [项目导出，#541](https://github.com/Paca-AI/paca/pull/541) | 未发现 Worker 导出聚合/API | 作为数据可携带性增量：任务/评论/活动 CSV、文档 Markdown；独立授权、分页生成、结果有时效。上游不包含文档评论/版本及全部附件内容，不能称为完整备份恢复 |
| [GitHub 分支/PR 状态与 BDD 插件，上游路线图](https://github.com/Paca-AI/paca/blob/09c3f873f594d1857afd16bc9a173317d9502f44/ROADMAP.md) | Worker 插件列表仍为空投影，运行时未迁移 | 优先考虑受限 GitHub 集成和结构化验收条件；“任务→Run→Commit/PR→CI→人工验收”是本地建议扩展，路线图勾选不作为插件已在本环境验收的证据 |

上线前补充核查（以下均未做本环境完整验收）：

- [ ] 个人视图配置与团队默认分离，默认保存“仅自己”，显式发布才改变共享配置。参考 [#545](https://github.com/Paca-AI/paca/pull/545)；当前 Worker View 主要是项目共享配置，不因上游前端已有入口而声明支持个人覆盖。
- [ ] 用户、成员、Agent 与关联任务选择器支持服务端搜索和游标分页；覆盖非首屏候选、已删除候选、空结果、键盘选择及失败重试。参考 [#551](https://github.com/Paca-AI/paca/pull/551)。
- [ ] 对照 [#552](https://github.com/Paca-AI/paca/pull/552) 的场景复核 Task/Document/Folder/Sprint/View 的并发更新、修改与删除竞态、父子关系和目录循环；复用已存在的 Worker 事务与版本保护，仅补未覆盖契约，不能把上游修复直接判为本地同一缺陷。
- [ ] 补齐搜索和异步结果的可理解反馈：明确关键词匹配范围、分页/截断、无结果与错误；Agent 或自动化失败需显示可操作原因，禁止未持久化字段仍提示保存成功。

已纳入后续计划的增量（尚未实施）：

- [ ] 项目 Skills 包：共享开发约束、测试及验收规范，保留 `SKILL.md` 与 references/assets，记录版本和本机采用状态；与仓库 `AGENTS.md` 合并时保留用户已有约束，不自动执行包内脚本。上游 [#453](https://github.com/Paca-AI/paca/issues/453) 的项目级注册/分发仍是开放需求，不能与现有 bundled/plugin Skills 混为已完成。
- [ ] 聊天图片/文件输入：支持粘贴、拖放、发送前预览和移除，文本与附件引用作为同一 turn；复用项目/任务附件权限，模型不支持时明确反馈。上游 [#397](https://github.com/Paca-AI/paca/issues/397) 仍开放，不把“可读任务附件”误认为“聊天可上传附件”。
- [ ] GitHub 交付门禁（优先）：以固定 Commit/PR 的真实 CI 和评审证据区分“Agent 执行完成”“等待验收”“验收通过”；不得仅凭 Agent 自报完成自动关闭任务或发布代码。

上游 `master` 已合入 [#557 IAM policy roles](https://github.com/Paca-AI/paca/pull/557)，尚不属于 `v0.18.6`。本分支继续遵守 Better Auth + `pacaPermission` + Agent Auth 单一权威与 clean-slate 约束；仅可借鉴权限编辑体验和测试场景，不能合入旧角色迁移、独立 Go IAM evaluator 或 legacy Agent API Key 路径。容器/RustFS/Valkey/WASM 插件实施也必须按当前架构重新评估，不能整体合并上游替代功能适配。

### 已知阻塞或待人工验收

- [x] 目标 Cloudflare 账号部署授权已恢复，项目 `paca` auth profile 已绑定并完成部署。
- [ ] Codex 内置浏览器控制稳定性仍待修复：清理重复页面后保留一个 Paca 标签，曾在当前聊天/面板前台下完成正文读取、DOM、截图和点击；后续跨轮读取再次超时，且一次 visibility 为 true 时仍超时，不能把前台状态当作充分恢复条件。页面功能验收尚未完成。
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
- [ ] 补充 Automation 等通用业务 Workflow 领域执行器，以及浏览器文件/SSH/Port Forward 契约；旧 Environment 数据直接舍弃。
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

### 当前实施节点：Automation Worker 原生重建

- 最小交付物：版本化 PostgreSQL 图模型、项目隔离的 graph repository 与领域校验；随后接入 Better Auth `workflows.read/write` 的 Hono 路由、Queue/Workflow 执行与幂等 run 记录，最后开放前端入口。未实现执行器前不得让图进入可触发的 active 状态。
- 验证命令：在本地 `_test` PostgreSQL 上运行 `bun run db:check`、`bun run typecheck`、`bun run lint`、`bun run test` 和 `bun run test:postgres`；路由与执行器就绪后增加真实 internal API/浏览器烟测与故障恢复验证。
- 回滚路径：未开放路由前只需撤回 Worker 代码，已应用的 additive migration 保留；internal 可用受确认串保护的 clean-slate 工具重建。开放后先回滚至已验证的 Worker 版本，并停止相关 Queue/Workflow 消费者；不对已提交的业务运行结果执行破坏性 down migration。
- [x] 图 schema、版本化 `0029` migration、项目隔离 repository、结构校验和 `workflows.read/write` Hono CRUD 已实现；本地空库重放、数据库契约与 HTTP 权限测试通过。
- [x] `0029` 已应用于 internal，图表 runtime role 权限已核对；带真实 Better Auth Session 的图 CRUD 烟测覆盖节点、边、非法边拒绝和归档。
- [x] Run/Step 只读查询已按现有前端契约迁移，限制单次查询量并经 Project 权限和数据库作用域双重约束。
- [x] `task_created`/`status_changed` 已在任务写入事务中写入独立 Automation outbox；专用 Queue/DLQ、租约恢复与重复消息处理已部署到 internal，并通过空库、PostgreSQL 和真实 Session 烟测。
- [x] Queue 消费已按事件匹配 active 图、持久化幂等 Run 与图快照，并用固定 Run ID 启动 Workflow；已实现 wait 步骤和失败记录。internal 真实任务事件至 Run/Step 完成烟测通过；重投与图编辑后恢复由 PostgreSQL 契约覆盖。
- [x] 受限图激活/停用已开放且要求 `workflows.execute`：仅允许六类已实现的任务事件触发器及已本地验证的到期调度、条件分支、`wait` 和已实现字段的 `update_task`；不支持的配置、模板或未实现动作在激活时拒绝，active 图必须先停用才可编辑或归档。新增四类触发器已部署 Worker，逐项远端验收仍未完成。
- [x] `0031` 的任务写入幂等 marker 与业务更新、系统 actor 审计同事务提交；PostgreSQL 契约覆盖重复调用，internal 真实烟测覆盖激活、任务事件→Workflow→`update_task`、活动记录、停用以及独立 wait 路径。
- [x] 条件节点的有序分支与 else 已接入持久 Workflow 步骤；支持任务/Sprint 字段、父子与关联任务目标及 any/all，并对配置、项目隔离和目标数量实施校验。PostgreSQL 契约与 internal 真实事件烟测覆盖命中/else 路径。
- [x] `update_task` 已扩展类型、状态、Sprint、父任务、描述、日期和指派；日期配置严格转为任务日期。`0032` 允许真实 `system` actor 的指派通知，PostgreSQL 契约覆盖重试时通知与审计不重复。
- [x] `update_task` 已支持 reporter 和 custom field 合并写入，并可将任务目标解析为当前、父子、指定或关联任务；目标集合在 Workflow 步骤中冻结，逐任务幂等键抵御批次部分成功后的重试。PostgreSQL 契约覆盖作用域、双子任务和重复投递；internal 真实事件烟测覆盖两个子任务的 Workflow 扇出、字段和审计。
- [x] `0033` 扩展 `assignee_changed`/`priority_changed`/`tag_added`：任务字段触发器与指派集合事务写入独立事件，tag 配置可过滤新增标签；空库迁移、PostgreSQL 事件/幂等契约、Worker 与 Web 测试通过，migration 和 Worker 已部署 internal，逐项远端烟测仍待完成。
- [x] `0034` 扩展 `predecessor_done`：激活时验证目标和监听任务均在当前项目；进入 Done 时冻结满足“全部完成”的触发节点，并用图行锁串行化并发完成；规划 Run 时再次检查任务状态和目标。空库迁移、并发 PostgreSQL 契约、Worker/Web 测试通过，migration 和 Worker 已部署 internal，逐项远端烟测仍待完成。
- [x] `0035` 新增持久唯一调度键及任务到期索引；每分钟有界捕获 `due_date_reached`，使用 UTC 零点加整数分钟偏移（±525600），延期后新日期可再次触发，消费时复查指定节点、图版本和任务日期；已接受 Run 保留快照恢复。完整本地回归和部署预检通过，internal migration/Worker 已部署，真实调度事件与浏览器验收仍待完成。
- [x] `0036` 新增 Cron 游标和四类 Sprint 事件；激活时初始化下一个 UTC 周期，错过周期合并补执行，节点行锁串行化并发捕获，事件和游标同事务提交。Sprint 删除快照及无 Task 条件/显式目标已接入 Workflow；前端校验和筛选已落地。完整本地回归、PostgreSQL 契约与 Workers 编排验收通过，已部署 internal，真实事件与浏览器验收仍待完成。
- [ ] 扩展 Automation 完整触发器与动作、Webhook token、调度和前端入口；补齐事件/动作矩阵、目标集合扩容、故障恢复与真实浏览器验收。受限图列表/编辑入口与节点选择已部署 internal，当前部署授权已恢复，真实浏览器验收仍待完成。

- [x] 已建立 Go API → Hono Worker 迁移清单、机器可检查 manifest、稳定 501 未迁移边界和 Worker 版本回滚策略。
- [x] React 保留 TanStack Router/Query/Form；Static Assets 与 `/api/*` 同源，SPA 深链与懒加载版本错位可恢复。
- [x] 已迁移 Project、Organization/Project 访问控制、Task/Activity/Link、Sprint/View/Custom Field、高级任务查询、首页我的任务、Project Agent 目录、Notification、Workspace Branding、Attachment、Document 和 Environment 纵向切片。
- [x] 未迁移页面由统一能力清单隐藏/重定向，不再先请求 legacy API 导致 404。
- [ ] 持续按“认证与只读 → 边界清晰写入 → 复杂事务”的顺序迁移剩余 API。
- [ ] 为仍需保持产品行为的模块补充新旧 API contract；不要求历史数据迁移或双写一致性。
- [ ] 完成真实浏览器 Sprint 生命周期、自定义字段和 View CRUD E2E。
- [ ] 补完 Automation 剩余触发器、动作、Webhook token、可靠调度和审计验收；完成完整领域契约后关闭 Automation/Webhook 501 domain 与 legacy worker。图 schema/repository/Hono API 和受限 Queue/Workflow 执行已完成，不再重复列为待重建。
- [ ] 重建 Agent Conversation 协议及 MCP Agent Auth 调用路径；完成后关闭对应 501 domain 与 Valkey conversation stream。
- [ ] 完成 Environment 浏览器文件/SSH/Port Forward 契约后，关闭剩余 legacy Environment 501 domain；不恢复已删除的 legacy backend。

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

- [x] CI 已覆盖 Worker 类型、Biome、Drizzle migration、单元测试、React internal build、Wrangler types/dry-run、PostgreSQL 集成测试，以及 Agent Runner lint/build/race/Docker E2E。
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
