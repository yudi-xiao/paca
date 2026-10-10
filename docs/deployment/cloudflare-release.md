# Paca 单一 prod 发布手册

Paca 只部署 prod。React、Hono API 和 Better Auth 同源于 `https://paca.howlearnwood.com`；Environment Gateway 使用 `https://paca-env.howlearnwood.com`。不建立 internal/staging、不拆分 GitHub App 或业务资源。所有命令使用项目绑定的 Wrangler `paca` auth profile。

## 既有资源

| 组件 | 唯一 prod 资源 |
| --- | --- |
| API Worker | `paca-worker-api-internal`（历史物理名） |
| Gateway Worker | `paca-environment-gateway-internal`（历史物理名） |
| PostgreSQL | `paca/prod`，分支 ID `dshooho15033` |
| Hyperdrive | `ec828e1b80664166ab38aa511cfd1f82` |
| Runtime role | `paca-worker-internal`，只允许版本化 runtime grants |
| R2 | `paca-attachments-internal` / `paca-document-snapshots-internal` |
| Queues / DLQ | `paca-{realtime-events,document-materialization,automation-events}-internal` 及各自 `-dlq` |
| Workflows | `paca-document-agent-internal` / `paca-automation-internal` |
| Sandbox application | `paca-environment-gateway-internal-sandbox-internal` |
| GitHub App | `paca-yudi-delivery`，App `5260553`，Installation `169867188` |

物理资源名与运行环境是不同概念。保留历史名字可复用 Secret、DO storage、业务数据和 Sandbox，不产生第二套环境。两个 Wrangler 文件均无 `env` 分支，`ENVIRONMENT=prod`；不要添加内部域名或再次初始化管理员。原工作区账号与密码继续有效。

## 发布

在 `services/worker-api`：

```bash
bun run build:web:production
bun run deploy:guard
bun run types:check
bun run typecheck
bun run lint
bun run test
bun run test:workers
bun run deploy:dry-run
```

PostgreSQL 契约和恢复测试只连接受保护的本机 `_test` 数据库；这不是另一套部署环境。使用 `PACA_TEST_DATABASE_URL` 后执行 `bun run test:postgres`。

Gateway 先发布，然后 API。使用项目锁定的 Wrangler 和 Node runtime：

```bash
# services/environment-gateway
bun run deploy:prod
# services/worker-api
bun run deploy:prod
bun run smoke:production
bun run github:app:verify
bun run github:app:webhook-config
```

不传 `--env`。Wrangler 部署保留现有 Secret；不轮换 Better Auth / Gateway / App 凭据。`smoke:production` 仅轮换私有数据库健康诊断 token，并创建受高熵 bearer 保护的短期固定范围 probe；验证后删除 probe 与私有临时文件。CLI 返回成功后仍需验证真实远端。

## 账号与 GitHub

生产 HTTP 注册始终关闭，管理员已在当前工作区。禁止复制密码、Session 或 legacy 身份。GitHub App 私钥缓存仅位于忽略的 `.paca/github-app/prod.json`，文件 0600、目录 0700，不进入 Git 或日志。既有 App 已安装至唯一 `yudi-xiao/paca`，权限仍为 Metadata/Checks/Pull requests 只读。

`github:app:setup` 在缓存存在时拒绝重复创建；有确切 Secret 修复需求时用 `github:app:setup --resume` 恢复同一个 App。回调地址保持 `https://paca.howlearnwood.com/api/integrations/github/webhook`。不要创建独立生产 App。

## 临时验收数据

正文检索和仓库设置 smoke 使用本机短期 operator role，通过 Better Auth 私有 API 创建 `smoke…@paca.test` 账号，再以实际远端登录取得 Session。要求真实 Owner 已存在，拒绝创建首位管理员；结束后删除临时账号和角色，公开注册不改变。

```bash
PACA_PLANETSCALE_ORG=463708580 PACA_PROD_SMOKE_CONFIRM=RUN_PACA_PROD_SMOKE PACA_SEARCH_SMOKE_CONFIRM=RUN_PROD_SEARCH_SMOKE bun run smoke:search:prod
PACA_PLANETSCALE_ORG=463708580 PACA_PROD_SMOKE_CONFIRM=RUN_PACA_PROD_SMOKE PACA_GITHUB_REPOSITORY_SMOKE_CONFIRM=RUN_PROD_GITHUB_REPOSITORY_SMOKE bun run smoke:github-repository:prod
```

测试不读取、修改或注销人类账号的 Session。现有用户 smoke 需要由操作员通过私有环境变量提供测试账号，禁止在聊天、argv、提交或输出里提供密码。

## 恢复与运行边界

发布前保存当前 Worker version 和数据库备份。失败可回滚同一 Worker 的代码版本；版本化数据库 migration 只执行经过审查的前滚，不把旧身份复制回来。发布不会自动合并 PR、批准任务交付或发布业务数据。

同源认证、Project 权限、Agent capability constraints、User/Agent Gateway registry、Queue 幂等与恢复仍是正式运行条件，不属于被移除的部署环境隔离。上线待办与实测证据统一记录在根目录 `TODO.md`。
