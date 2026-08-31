# 旧附件迁移到 Cloudflare R2

本工具用于把旧 Go API 使用的 `files`、`task_attachments` 与 S3/MinIO 对象迁移到 Worker 使用的 `paca_file`、`paca_task_attachment` 与 R2。入口为：

```bash
cd services/api
go run ./cmd/attachment-migrate
```

工具不会读取 Worker Secret 或 Wrangler 配置。数据库和对象存储凭据必须通过当前进程环境变量临时提供，不得写入仓库、命令日志或迁移台账。

## 安全模型

- 默认命令是 `preview`，只读取旧数据库与目标 Project/Task 作用域，不写数据库或对象存储。
- `plan` 只写 `paca_attachment_migration_item` 台账，不复制对象；必须显式确认 run ID。
- `apply` 复制对象并写目标元数据；必须再次用同一 run ID 确认。
- `verify` 是只读操作，会重新读取 R2 对象并计算 SHA-256，同时核对目标数据库元数据。
- `rollback` 只删除台账证明由该 run 创建的对象、`paca_file` 和 `paca_task_attachment`。已存在且仅被复用的资源不会被删除。
- 同一源附件在任一时刻只能属于一个尚未回滚的 run；如需重试必须继续使用原 run ID，完整回滚后才能用新 run 重新计划。
- 孤儿治理默认是 `orphan-audit`。`orphan-delete` 需要明确的 RFC3339 截止时间和与该时间完全一致的删除确认。
- 孤儿扫描只处理符合以下固定结构的任务附件 key，不处理文档、头像或其他对象：

```text
organizations/{organizationId}/projects/{projectId}/tasks/{taskId}/attachments/{fileId}/{fileName}
```

- 数据库是引用关系的权威来源。删除孤儿前会再次查询 `paca_file.storage_key`，不会把一次 R2 bucket listing 当成权威状态。

## 前置条件

1. 先在目标 PostgreSQL 按顺序应用 Worker migrations 至 `0014_clear_ultron`。`0012` 建立迁移台账，`0014` 建立“一个源附件只能属于一个 active run”的数据库唯一约束。
2. 旧 Project、Task 与 Better Auth 用户迁移应先完成。Project/Task UUID 必须能在目标 `paca_project`、`paca_task` 中解析；找不到目标作用域的附件会在预览结果中以 `TARGET_SCOPE_MISSING` 报告，不会迁移。
3. 使用直接数据库连接执行迁移，不通过 Hyperdrive。迁移账号需要：
   - 读取旧 `files`、`task_attachments`、`tasks`；
   - 读写迁移台账及目标附件表；
   - 读取目标 Project、Task 和 User。
4. Worker runtime role 不应取得 `paca_attachment_migration_item` 权限。
5. 为旧 S3/MinIO 和 R2 分别准备最小对象权限凭据。R2 凭据至少需要目标 bucket 的读取、写入、列举和删除权限；迁移完成后应撤销临时凭据。
6. 临时目录必须有容纳单个最大附件的空间。工具以临时文件转存，避免把 512 MiB 附件全部读入内存，并在每项结束后删除临时文件。

## 环境变量

数据库与通用配置：

```text
LEGACY_DATABASE_URL
DATABASE_URL
R2_BUCKET
PACA_ATTACHMENT_MIGRATION_COMMAND
PACA_ATTACHMENT_MIGRATION_RUN_ID
PACA_ATTACHMENT_MIGRATION_PAGE_SIZE        # 默认 100，范围 1–1000
PACA_ATTACHMENT_MIGRATION_TEMP_DIR         # 可选
```

旧 S3/MinIO，仅 `apply` 需要：

```text
LEGACY_S3_ENDPOINT                         # AWS S3 可为空
LEGACY_S3_REGION                           # 默认 us-east-1
LEGACY_S3_ACCESS_KEY_ID
LEGACY_S3_SECRET_ACCESS_KEY
LEGACY_S3_FORCE_PATH_STYLE                 # MinIO 默认 true
```

R2 S3 API，`apply`、`verify`、`rollback` 和孤儿命令需要：

```text
R2_S3_ENDPOINT                             # https://{accountId}.r2.cloudflarestorage.com
R2_REGION                                  # 默认 auto
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_FORCE_PATH_STYLE                        # 默认 false
```

`R2_S3_ENDPOINT` 必须是无路径、无凭据的 HTTPS Cloudflare R2 account endpoint；工具会拒绝明文 HTTP 或第三方主机，避免把 R2 临时凭据发送到错误目标。显式设置的布尔变量若不是合法的 `true`/`false` 也会直接失败，不会静默回退。

## 推荐执行顺序

### 1. 只读预览

不设置命令时默认为 `preview`，自动生成一个仅用于展示的 run ID：

```bash
PACA_ATTACHMENT_MIGRATION_COMMAND=preview \
LEGACY_DATABASE_URL='…' \
DATABASE_URL='…' \
R2_BUCKET='…' \
go run ./cmd/attachment-migrate
```

输出为 JSON。只有 `skipped=0` 时才应进入正式 plan；`issues` 最多返回前 100 个失败附件及稳定错误码。

### 2. 固化迁移计划

生成新的 UUID，随后让 run ID 与确认值完全相同：

```text
PACA_ATTACHMENT_MIGRATION_COMMAND=plan
PACA_ATTACHMENT_MIGRATION_RUN_ID={runId}
PACA_ATTACHMENT_MIGRATION_PLAN={runId}
```

重复执行同一 run 的 plan 是幂等的，已存在项目不会重复写入台账；但源 bucket/key、文件 ID、大小、目标作用域或规范化 key 与首次计划不一致时会失败，不会静默沿用已漂移的源数据。另一个 active run 已认领同一源附件时，数据库唯一约束会拒绝新计划。

### 3. 复制并导入

配置源对象存储与 R2 凭据，并设置：

```text
PACA_ATTACHMENT_MIGRATION_COMMAND=apply
PACA_ATTACHMENT_MIGRATION_RUN_ID={runId}
PACA_ATTACHMENT_MIGRATION_APPLY={runId}
```

每个附件按以下顺序执行：

1. 校验旧数据库大小与源对象 `Content-Length`。
2. 将源对象流式写入临时文件并计算 SHA-256。
3. 若目标 key 已存在，完整读取并比较 SHA-256；内容不同则拒绝覆盖。
4. 目标不存在时使用 `If-None-Match: *` 条件写入，防止检查与上传之间的并发覆盖；条件冲突后只允许复用 SHA-256 一致的对象，并根据迁移 metadata 判断本 run 是否拥有该对象。
5. 上传 R2 后再次读取并计算 SHA-256。
6. 在目标 PostgreSQL 单一事务中写 `paca_file`、`paca_task_attachment` 并更新台账所有权。

失败项记录稳定 `error_code`，可以在修复外部问题后用同一 run ID 重试。

### 4. 完整校验

```text
PACA_ATTACHMENT_MIGRATION_COMMAND=verify
PACA_ATTACHMENT_MIGRATION_RUN_ID={runId}
```

`verify` 会检查该 run 的全部台账项；任何仍处于 `planned`、`copied`、`failed`、`rollback_started` 或 `rolled_back` 的项都计为失败，未知/空 run 也直接失败。只有 `failed=0` 且 `succeeded` 等于 plan 数量时才能切换流量。迁移报告应保存数量和 run ID，但不得保存连接串、Access Key 或 Secret。

### 5. 回滚

```text
PACA_ATTACHMENT_MIGRATION_COMMAND=rollback
PACA_ATTACHMENT_MIGRATION_RUN_ID={runId}
PACA_ATTACHMENT_MIGRATION_ROLLBACK={runId}
```

回滚先把台账置为 `rollback_started`，再删除本 run 拥有的 R2 对象，最后在数据库事务中删除本 run 拥有的目标元数据并置为 `rolled_back`。`planned` 和因复制/导入失败而处于 `failed` 的项同样可回滚，确保已经复制但尚未成功导入的对象不会被遗留。中断后可用相同命令重试。

## 孤儿对象审计与删除

默认使用至少 30 天之前的对象进行只读审计，也可以显式提供 RFC3339 截止时间：

```text
PACA_ATTACHMENT_MIGRATION_COMMAND=orphan-audit
PACA_ATTACHMENT_ORPHAN_BEFORE=2026-07-01T00:00:00Z
```

确认审计结果后才能删除。删除要求：

```text
PACA_ATTACHMENT_MIGRATION_COMMAND=orphan-delete
PACA_ATTACHMENT_ORPHAN_BEFORE=2026-07-01T00:00:00Z
PACA_ATTACHMENT_ORPHAN_DELETE=DELETE_ORPHANS_BEFORE:2026-07-01T00:00:00Z
```

孤儿引用查询同时按目标 bucket 和 storage key 过滤，并在删除前再次查询数据库。先在隔离 bucket 验证，生产执行前保存 R2 bucket 备份或确认对象版本/恢复策略。不要把孤儿删除作为迁移 apply 的自动后置步骤，也不要与 attachment migration `apply` 并行执行。
