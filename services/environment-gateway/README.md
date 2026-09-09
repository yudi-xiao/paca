# Paca Environment Gateway

该 Worker 是 Paca Agent Auth 与实际执行环境之间的私有、版本化边界。Worker API 通过
Service Binding 调用 `https://environment-gateway.internal/v1/connections`，Gateway 仅在
该内部 origin 上签发最长 60 秒的连接票据。公开的 `/v1/connect` 只接受签名票据：

- `read`：`POST` JSON `{ "action": "status" }`，只返回脱敏后的进程状态。
- `execute`：先可选 `POST` JSON `{ "action": "prepare" }` 预热并确认 provider 就绪，再以
  WebSocket Upgrade 代理到 Cloudflare Sandbox 的 PTY；prepare 不消费票据，PTY 票据只允许
  消费一次。

Gateway 将 provider 失败收敛为不含平台原始消息的稳定 JSON 信封：
`GATEWAY_PROVIDER_STARTING`、`GATEWAY_PROVIDER_CAPACITY`、
`GATEWAY_PROVIDER_TRANSIENT`、`GATEWAY_PROVIDER_OPERATION_UNCERTAIN`、
`GATEWAY_PROVIDER_FAILED` 或 `GATEWAY_PROVIDER_UNSUPPORTED`。信封明确提供 `retryable`、
有界 `retryAfterMs` 和 `attempts`；只有容器明确尚未接收操作，或 prepare/status 这类只读操作，
才允许有限重试。传输中断后结果可能不确定的 PTY/终止操作不得自动重放。

HTTP 客户端使用 `Authorization: Bearer <accessToken>`。浏览器 WebSocket 无法设置
Authorization header 时，可把 `paca-ticket.<accessToken>` 作为 WebSocket subprotocol；
Gateway 在转发到 Sandbox 前会移除票据、Cookie 与 subprotocol header。

当前 provider 使用稳定版 `@cloudflare/sandbox@0.12.9`，容器镜像固定到与该版本对应的
Docker Hub digest。`cloudflare-computer` 和 legacy runner 尚未在 Gateway 中启用，不能通过
修改数据库 backend 字段绕过 provider 检查。

部署前必须配置独立 Secret：

```bash
bunx wrangler secret put CONNECTION_TICKET_SECRET --env internal
```

Secret 至少 32 字节，不得与 Better Auth、数据库或其他服务的 Secret 共用。先部署本
Gateway，再在 `paca-worker-api-internal` 添加名为 `ENVIRONMENT_GATEWAY`、目标为
`paca-environment-gateway-internal` 的 Service Binding。

部署后从 `services/worker-api` 运行 `smoke:environment:internal`。测试所需的 Project、审批
账号和 PlanetScale Organization 只能通过 `PACA_PROJECT_ID`、`PACA_APPROVER_EMAIL`、
`PACA_APPROVER_PASSWORD`、`PACA_PLANETSCALE_ORG` 环境变量注入；设置
`PACA_ENVIRONMENT_SMOKE_MODE=read` 验证脱敏状态查询，设置为 `execute` 验证 PTY 双向
二进制帧、冷 Sandbox prepare 和一次性票据重放拒绝。每次 smoke 使用新的 Sandbox ID，
输出只包含客户端/provider 尝试次数和就绪耗时，不输出连接票据或数据库凭据，并在退出前
撤销临时 Grant/Agent/Session、删除环境 scope 和短期数据库 role。
