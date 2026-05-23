# MiniBili Workers

MiniBili 的 Cloudflare Workers 自动化服务，包含三件事：

- 接收 Xcode Cloud webhook，从 App Store Connect 读取该 build 的 TestFlight 更新内容，发送 Telegram 构建通知。
- 记录 TestFlight 公开群组延迟同步任务：股东先用，30 天后开放给其他外部群组。
- 提供本地脚本，从 App Store Connect 抓历史 build 并回填到 D1。

## 目录

- `src/index.js`：Worker 服务入口。
- `migrations/0001_testflight_public_rollouts.sql`：D1 表结构。
- `scripts/backfill-public-rollouts.js`：把本地 JSON 回填到远端 D1。
- `scripts/sync_asc_public_rollouts.py`：从 App Store Connect 抓历史 build，打印官方数据，再回填到远端 D1。
- `examples/backfill-public-rollouts.sample.json`：手工回填示例。
- `wrangler.toml`：Cloudflare Workers 配置。

## 首次部署

1. 安装依赖：

```bash
npm install
```

2. 创建 D1 数据库：

```bash
npx wrangler d1 create minibili-testflight
```

把命令输出里的 `database_id` 填到 `wrangler.toml`。

3. 应用 D1 migration：

```bash
npm run db:migrate:remote
```

4. 配置 secrets：

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put XCODE_CLOUD_WEBHOOK_SECRET
npx wrangler secret put ASC_ISSUER_ID
npx wrangler secret put ASC_KEY_ID
npx wrangler secret put ASC_PRIVATE_KEY
npx wrangler secret put PUBLIC_ROLLOUT_ADMIN_SECRET
```

如果公开 TG 大群和股东群不同，再配置：

```bash
npx wrangler secret put PUBLIC_TELEGRAM_CHAT_ID
```

如果要同步发到公开频道，再配置：

```bash
npx wrangler secret put PUBLIC_TELEGRAM_CHANNEL_ID
```

5. 安装 Python 同步脚本依赖：

```bash
pip3 install "PyJWT[crypto]" certifi
```

6. 检查语法并部署：

```bash
npm run check
npm run deploy
```

## 关键变量

`wrangler.toml` 里可直接改：

- `PUBLIC_ROLLOUT_WORKFLOW_NAMES`：只登记这些 Xcode Cloud 工作流，逗号分隔。
- `ASC_DELAY_DAYS`：默认 30。
- `ASC_SYNC_BUILD_LIMIT`：默认 5。北京时间 07:00 的线上同步只扫描最近这些个 ASC build。
- `ASC_SHAREHOLDER_GROUP_NAME`：默认 `股东`，Cron 会排除这个外部群组。
- `ASC_SHAREHOLDER_GROUP_ID`：可选，Cron 也会按群组 ID 排除股东群。
- `PUBLIC_ROLLOUT_LIMIT`：每次 Cron 最多处理几条到期任务。
- `PUBLIC_ROLLOUT_MAX_ATTEMPTS`：失败多少次后标记 `FAILED`。
- `SHAREHOLDER_APP_NAME`：股东群实时通知里显示的名称。
- `PUBLIC_APP_NAME`：公开大群通知里显示的名称。
- `PUBLIC_TELEGRAM_PIN_MESSAGE`：设为 `true` 时，公开大群通知发送成功后自动置顶。
- `PUBLIC_TELEGRAM_PIN_DISABLE_NOTIFICATION`：设为 `true` 时，置顶时不额外通知群成员。
- `PUBLIC_TELEGRAM_CHANNEL_ID`：可选，公开频道 ID。可以是 `@channel_username` 或 `-100...` 数字 ID。
- `PUBLIC_TELEGRAM_CHANNEL_PIN_MESSAGE`：设为 `true` 时，公开频道通知发送成功后自动置顶。
- `PUBLIC_TELEGRAM_CHANNEL_PIN_DISABLE_NOTIFICATION`：设为 `true` 时，置顶频道消息时不额外通知订阅者。

secret 里配置：

- `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`、`TELEGRAM_THREAD_ID`
- `PUBLIC_TELEGRAM_CHAT_ID`、`PUBLIC_TELEGRAM_THREAD_ID`
- `XCODE_CLOUD_WEBHOOK_SECRET`
- `ASC_ISSUER_ID`、`ASC_KEY_ID`、`ASC_PRIVATE_KEY`
- `PUBLIC_ROLLOUT_ADMIN_SECRET`

TG bot 可以发频道消息，但必须是频道管理员，并且拥有 Post messages/发布消息权限。自动置顶公开大群或频道消息时，bot 还必须拥有 Pin messages/置顶消息权限。


## 本地与线上配置

`.dev.vars` 是本地配置文件：

- `wrangler dev` 会读取它。
- `scripts/sync_asc_public_rollouts.py` 默认也会读取它。
- 线上 Worker 不会读取你的本地 `.dev.vars`。

线上部署时，需要在 Cloudflare Dashboard 的 Worker 设置里配置同名的“变量和机密”，或者用 `wrangler secret put` 配置 secret。`ASC_PRIVATE_KEY` 可以直接粘贴 `.p8` 的完整多行内容，Worker 和 Python 脚本都支持真实换行，也支持写成 `\n`。

本地 `.dev.vars` 推荐这样写多行私钥：

```dotenv
ASC_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
PASTE_YOUR_REAL_P8_CONTENT_HERE
-----END PRIVATE KEY-----"
```

## Xcode Cloud Webhook

把 Worker URL 填到 Xcode Cloud webhook。请求头 secret 使用：

```text
x-xcode-webhook-secret
```

Worker 只处理 `BUILD_COMPLETED`。构建通知使用 webhook 里的 `app.id` 和 `ciBuildRun.attributes.number` 找到 App Store Connect build，再读取 `betaBuildLocalizations.whatsNew` 作为 Telegram 更新内容。webhook 不负责登记 30 天公开任务，因为它不包含 TestFlight 群组归属。

## 30 天公开同步

线上 D1 任务以 App Store Connect 为事实来源，不以 Xcode Cloud webhook 为准。每天有两个 Cron：

- 北京时间 07:00：同步最近 `ASC_SYNC_BUILD_LIMIT` 个 ASC build、更新内容、外部群组、群组-build 关系到 D1。
- 北京时间 08:00：检查 D1 中到期的 `SCHEDULED` 任务，满 30 天后开放给公开群组并发大群 TG 通知。

07:00 同步会写入或更新 D1：

- `app_id`
- `build_run_id`
- `ci_build_number`
- `workflow_name`
- `tag_name`
- `notes`
- `release_at`
- `due_at = release_at + ASC_DELAY_DAYS`
- `shareholder_groups_json`：历史回填时记录已拥有该 build 的股东群。
- `target_groups_json`：记录已拥有或已同步的公开群组。

08:00 公开视频任务只处理 D1 里已经登记且到期的任务，不会每天全量扫描 App Store Connect 历史 build：

1. 用 App Store Connect API 找 build。
2. 如果 D1 里的 notes 为空，再读取 `betaBuildLocalizations.whatsNew` 补齐。
3. 列出所有外部 TestFlight 群组。
4. 排除 `ASC_SHAREHOLDER_GROUP_NAME` 和 `ASC_SHAREHOLDER_GROUP_ID`。
5. 把 build 加到其他外部群组。
6. 向公开 TG 大群发送通知。

公开群组不要开启“自动接收所有 build”，否则会绕过 30 天延迟。

## 历史 Build 回填

本地脚本默认只看最近 5 天，适合日常小范围核对：

```bash
python3 scripts/sync_asc_public_rollouts.py --dry-run
```

要把过去一个月或更久的历史 build 回填到 D1，显式传 `--since-days 45`。脚本会默认读取本地 `.dev.vars`，先打印 Apple 官方返回的 builds、betaBuildLocalizations、外部 beta groups、每个群组当前拥有的 builds，再打印即将发送给 Worker 写入 D1 的 JSON：

```bash
python3 scripts/sync_asc_public_rollouts.py --since-days 45 --dry-run
```

确认后写入远端 D1：

```bash
python3 scripts/sync_asc_public_rollouts.py --since-days 45
```

如果不想用默认 `.dev.vars`，可以指定其他文件：

```bash
python3 scripts/sync_asc_public_rollouts.py --vars-file path/to/.dev.vars --since-days 45
```

历史 build 的 notes 来自 Apple 的 `betaBuildLocalizations.whatsNew`。如果 Apple 没有返回更新内容，脚本会把 notes 留空；不会再给历史版本填统一默认文案。过期 build 会同步到 D1，但状态是 `SKIPPED_EXPIRED`，Cron 不会再尝试公开视频。

历史 build 的群组归属来自 Apple 的 `betaGroups/{id}/builds`。回填 JSON 里 `shareholderGroups` 表示已经拥有该 build 的股东群，`targetGroups` 表示已经拥有该 build 的公开群组。如果 build 已经在公开群组里，回填到 D1 时会标记为 `DONE`；如果只在股东群里且未过期，会标记为 `SCHEDULED`，等到 `due_at` 再公开。

如果你已经手工整理好了 JSON：

```bash
WORKER_URL='https://your-worker.example.workers.dev' \
PUBLIC_ROLLOUT_ADMIN_SECRET='your-secret' \
node scripts/backfill-public-rollouts.js examples/backfill-public-rollouts.sample.json
```

## 本地开发

复制 `.dev.vars.example` 为 `.dev.vars`，填入测试用 secret，然后：

```bash
npm run dev
```
