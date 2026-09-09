# Paca Environment Gateway

该 Worker 是 Paca Agent Auth 与实际执行环境之间的私有、版本化边界。Worker API 通过
Service Binding 调用 `https://environment-gateway.internal/v1/connections`，Gateway 仅在
该内部 origin 上签发最长 60 秒的连接票据。公开的 `/v1/connect` 只接受签名票据：

- `read`：`POST` JSON `{ "action": "status" }`，只返回脱敏后的进程状态。
- `execute`：WebSocket Upgrade，代理到 Cloudflare Sandbox 的 PTY；票据只允许消费一次。

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
