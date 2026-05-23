# MiniBili Workers

MiniBili 的 Cloudflare Workers 自动化服务，包含三件事：

- 接收 Xcode Cloud webhook，读取触发构建的 tag message，发送 Telegram 构建通知。
- 记录 TestFlight 公开群组延迟同步任务：股东先用，30 天后开放给其他外部群组。
- 提供本地脚本，从 App Store Connect 抓历史 build 并回填到 D1。

## 目录

- `src/index.js`：Worker 服务入口。
- `migrations/0001_testflight_public_rollouts.sql`：D1 表结构。
- `scripts/backfill-public-rollouts.js`：把本地 JSON 回填到远端 D1。
- `scripts/sync-asc-public-rollouts.js`：从 App Store Connect 抓历史 build，再回填到远端 D1。
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
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put ASC_ISSUER_ID
npx wrangler secret put ASC_KEY_ID
npx wrangler secret put ASC_PRIVATE_KEY
npx wrangler secret put PUBLIC_ROLLOUT_ADMIN_SECRET
```

如果公开 TG 大群和股东群不同，再配置：

```bash
npx wrangler secret put PUBLIC_TELEGRAM_CHAT_ID
```

5. 检查语法并部署：

```bash
npm run check
npm run deploy
```

## 关键变量

`wrangler.toml` 里可直接改：

- `PUBLIC_ROLLOUT_WORKFLOW_NAMES`：只登记这些 Xcode Cloud 工作流，逗号分隔。
- `ASC_DELAY_DAYS`：默认 30。
- `ASC_SHAREHOLDER_GROUP_NAME`：默认 `股东`，Cron 会排除这个外部群组。
- `PUBLIC_ROLLOUT_LIMIT`：每次 Cron 最多处理几条到期任务。
- `PUBLIC_ROLLOUT_MAX_ATTEMPTS`：失败多少次后标记 `FAILED`。

secret 里配置：

- `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`、`TELEGRAM_THREAD_ID`
- `PUBLIC_TELEGRAM_CHAT_ID`、`PUBLIC_TELEGRAM_THREAD_ID`
- `XCODE_CLOUD_WEBHOOK_SECRET`
- `GITHUB_TOKEN`
- `ASC_ISSUER_ID`、`ASC_KEY_ID`、`ASC_PRIVATE_KEY`
- `PUBLIC_ROLLOUT_ADMIN_SECRET`

## Xcode Cloud Webhook

把 Worker URL 填到 Xcode Cloud webhook。请求头 secret 使用：

```text
x-xcode-webhook-secret
```

Worker 只处理 `BUILD_COMPLETED`。构建通知使用 webhook 里的 `scmGitReference.attributes.name` 精确读取触发构建的 tag，不读取“最新 tag”。

## 30 天公开同步

命中 `PUBLIC_ROLLOUT_WORKFLOW_NAMES` 且构建成功时，Worker 会写入 D1：

- `app_id`
- `build_run_id`
- `ci_build_number`
- `workflow_name`
- `tag_name`
- `notes`
- `release_at`
- `due_at = release_at + ASC_DELAY_DAYS`

Cron 每小时检查到期任务：

1. 用 App Store Connect API 找 build。
2. 列出所有外部 TestFlight 群组。
3. 排除 `ASC_SHAREHOLDER_GROUP_NAME`。
4. 把 build 加到其他外部群组。
5. 向公开 TG 大群发送通知。

公开群组不要开启“自动接收所有 build”，否则会绕过 30 天延迟。

## 历史 Build 回填

先 dry-run 看最近 45 天会同步哪些 build：

```bash
ASC_ISSUER_ID='issuer-id' \
ASC_KEY_ID='key-id' \
ASC_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----' \
ASC_APP_ID='6753876871' \
node scripts/sync-asc-public-rollouts.js --since-days=45 --dry-run
```

确认后写入远端 D1：

```bash
ASC_ISSUER_ID='issuer-id' \
ASC_KEY_ID='key-id' \
ASC_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----' \
ASC_APP_ID='6753876871' \
APP_NAME='MiniBili-先行版' \
BACKFILL_NOTES='修复了一些已知问题，提升整体流畅度。' \
WORKER_URL='https://your-worker.example.workers.dev' \
PUBLIC_ROLLOUT_ADMIN_SECRET='your-secret' \
node scripts/sync-asc-public-rollouts.js --since-days=45
```

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
