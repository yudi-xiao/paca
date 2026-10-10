# GitHub 交付验收

交付绑定到具体 Task、已完成的 Agent task lease、PR 编号和固定 head SHA。Agent 执行完成只表示运行结束。服务端重新读取 GitHub 的 CI 和评审证据，随后由有任务写权限的用户接受或要求修改。这个流程不会自动合并 PR、部署代码或修改 Task 状态。

工程状态和启用验收条件统一见根目录 [TODO.md](../../TODO.md)。上线前须完成 GitHub App、Webhook、页面交互和真实交付链路验收。

## GitHub App

为 Paca 创建专用 GitHub App，只安装到批准的仓库。仓库权限为 Metadata: Read、Checks: Read、Pull requests: Read；无需 Contents、Actions、Issues 或写权限。Paca 每次请求签发仅覆盖目标 repository ID 的短期 installation token，校验返回的仓库 ID、名称、权限和有效期。Token 和 App 私钥不会进入业务数据库、日志或客户端。

Worker 从 Secret 读取 `GITHUB_APP_ID` 和 `GITHUB_APP_PRIVATE_KEY`。App ID 为应用数字 ID；私钥使用 GitHub 下载的 RSA PEM，由本机私有文件传入 Wrangler，不要写入仓库或聊天。先确认 Wrangler 使用项目的 `paca` profile，再在 Worker 目录配置：

专用 internal App 可以通过本地 manifest 引导创建：在 Worker 目录执行 `bun run github:app:setup`，在 Codex 浏览器打开输出的本机地址，再以 `yudi-xiao` 创建私有 App，并仅安装到 `paca` 仓库。回调有一次性随机 state 和路径保护，不使用用户 OAuth。脚本校验 App 所有者、只读权限和 RSA 私钥，忽略 GitHub 返回的 OAuth client secret；将必要凭据保存到 Git 忽略的 `.paca/github-app/internal.json`（权限 `0600`），并通过 stdin 写入 `paca` profile 对应 Worker 的三个 Secret。写入失败可以用 `bun run github:app:setup --resume` 恢复，不重复创建 App。引导页面 55 分钟后关闭。

安装后执行 `bun run github:app:verify`，确认安装属于 `yudi-xiao`、选择指定仓库且未暂停、只读权限、目标仓库可访问，并发送一次签名 ping 验证 Worker Secret。命令只输出配置所需的非敏感 App/Installation/Repository ID；不会自动为项目指定 CI 名称或评审策略。

```sh
bunx wrangler secret put GITHUB_APP_ID --env internal
bunx wrangler secret put GITHUB_APP_PRIVATE_KEY --env internal < /secure/path/paca-github-app.pem
bunx wrangler secret put GITHUB_WEBHOOK_SECRET --env internal
```

这些命令只配置 internal。生产资源、Secret 和安装范围须单独验收。实现依据：[GitHub installation token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)、[App JWT](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app) 和 [Workers crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)。

## 用户 API

API 使用同源 Better Auth 用户 Session。仓库配置同时要求项目 `projects.write` 和实例 `settings.write`，以批准共享 App 凭据访问的边界。交付查询要求 `tasks.read`，提交、刷新和人工决定要求 `tasks.write`。Agent JWT 不能代替用户 Session 完成人工验收。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET/PUT | `/api/v1/projects/:projectId/github-repository` | 读取或配置仓库及验收策略 |
| GET/POST | `/api/v1/projects/:projectId/tasks/:taskId/delivery` | 读取交付或提交固定 PR/SHA |
| POST | `/api/v1/projects/:projectId/tasks/:taskId/delivery/refresh` | 从 GitHub 更新证据 |
| POST | `/api/v1/projects/:projectId/tasks/:taskId/delivery/decision` | 用户接受或要求修改 |

请求使用 JSON，字段采用 camelCase。每次新操作生成 UUID `requestId`；仅重试完全相同的请求时复用。`expectedVersion` 来自最近读取结果，首次配置或提交为 `0`。版本冲突时重新加载并核对目标，不自动覆写。

仓库配置请求（数字 ID 和策略须替换为实际批准的值）：

```json
{
  "requestId": "11111111-1111-4111-8111-111111111111",
  "expectedVersion": 0,
  "repositoryId": 100,
  "installationId": 200,
  "policy": {
    "owner": "example-owner",
    "repository": "example-repository",
    "requiredChecks": [{ "name": "Tests", "appId": 123 }],
    "maxCheckAgeSeconds": 86400,
    "requiredApprovals": 1,
    "reviewerIds": [456]
  }
}
```

每个 Check 同时固定名称和发布它的 GitHub App ID，不将 Paca 的 App ID 自动当作 CI 发布者。评审策略使用获信任 GitHub 用户的数字 ID；PR 作者自己的批准不计入。服务端拒绝未知、过期、截断、错误仓库或其他提交的证据。

提交交付包含 `requestId`、`expectedVersion`、`leaseId`、`pullNumber` 和完整 40 位小写 `headSha`。租约须已完成且属于 URL 的项目及 Task。浏览器不提交 CI 结果、验收身份、其他仓库 URL 或证据 payload。

刷新包含 `requestId`、`expectedVersion`。人工决定另含 `decision`（`accept` 或 `request_changes`）和可选 `note`（最多 2000 字符）。接受前服务端重新采集证据，并在外部请求后复查用户权限；要求修改可以在 GitHub 暂时不可用时提交。CI 变绿或刷新不会自动覆盖人工要求修改。

## 状态与恢复

Webhook 地址为 `/api/integrations/github/webhook`。使用 `GITHUB_WEBHOOK_SECRET` 对原始请求 bytes 校验 HMAC-SHA256 后，接收 Check、PR、评审及安装撤销事件。投递 UUID、摘要和失效更新在同一 PostgreSQL 事务中提交；同 ID 的相同投递不会重复递增版本，不同内容返回冲突。仅保存路由信息与摘要，不保存 PR 或评审正文。安装撤销/移除仓库会撤销对应绑定，重新安装后须显式重新配置。迟到的成功事件也只会失效证据，不能通过验收；人工要求修改保留。

请求上限为 1 MiB；一次安装事件最多涉及 100 个项目，超限会拒绝整个事务。投递回执保留 30 天，每分钟清理最多 500 条。失败的 GitHub 投递须通过 GitHub 的投递页面重新投递；遗漏通知时，证据时效限制与接受前重新查询仍然生效。

`awaiting_acceptance` 表示 CI 和评审门禁就绪，等待用户决定；`accepted` 表示用户接受了这个固定提交。`waiting`、`needs_changes`、`stale`、`unavailable` 均不能直接接受。修改仓库或策略会失效旧交付并递增版本，提交不同 SHA 时清除旧决定。

接受和刷新受策略版本、交付版本及幂等键保护。GitHub 读取失败时旧接受状态失效；证据超过一分钟时读取响应要求刷新，将旧接受归入历史信息。业务审计保留决定、可信 actor、固定租约/仓库/PR/SHA 和安全门禁摘要。

缺少 App 配置返回 `GITHUB_DELIVERY_APP_NOT_CONFIGURED`，不退回个人 Token 或 Agent API Key。版本冲突须重新读取。GitHub 网络、权限及超大响应错误使用稳定错误码，不返回原始错误、Token 或 PEM。
