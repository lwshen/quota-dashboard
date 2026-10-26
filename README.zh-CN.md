> [English](./README.md) | **中文**

# Quota Dashboard

在网页中展示 AI 服务商配额 / 用量的看板。在服务端抓取各服务商的用量，把各家不同的用量接口归一化成统一的 `RateWindow` / `UsageSnapshot` 模型，由前端统一展示。

> **完全独立的子项目**：自带 pnpm workspace 与依赖，与外层仓库无任何耦合。

## 架构

```
前端 (Next.js App Router, React)         ← 只消费归一化的 UsageSnapshot
        │ GET /api/usage  POST /api/credentials  POST /api/refresh
后端代理 (Next route handlers, Node 运行时)
        │ · 凭据加密存储 (AES-256-GCM + SQLite)
        │ · 后台轮询 + OAuth token 刷新 (instrumentation 启动)
        │ · 注入 Authorization/Cookie/自定义头，绕过浏览器 CORS 限制
        ↓ 上游 HTTPS（服务端，无 CORS）
api.anthropic.com · chatgpt.com/backend-api · api.kimi.com · ...
```

**为什么必须有后端**：浏览器受 CORS、httpOnly cookie 不可读、禁设 `Cookie`/`User-Agent` 头、拿不到本地凭据等限制，无法直接调这些用量端点。所有上游请求都在 Node 服务端发出。

## 目录结构

```
quota-dashboard/
├─ packages/core/          # 与服务商无关的核心（可独立测试）
│  └─ src/
│     ├─ model.ts          # RateWindow / UsageSnapshot 等统一模型
│     ├─ adapter.ts        # ProviderFetchStrategy / runPipeline 管线
│     ├─ decode.ts         # 容错解码 helper
│     ├─ http.ts           # HttpClient 抽象 + Node fetch 实现
│     ├─ registry.ts       # provider 注册表
│     └─ providers/        # kimi / moonshot / claude / codex / grok / rightapi
└─ apps/web/               # Next.js 看板 + 后端代理
   ├─ app/                 # 页面 + API routes
   ├─ components/          # ProviderCard / RateWindowBar / 表单
   └─ lib/                 # db / crypto / store / fetcher / poller
```

## 已实现的 provider

| Provider     | 路径                                               | 凭据                                 | 产出                                          |
| ------------ | -------------------------------------------------- | ------------------------------------ | --------------------------------------------- |
| **Kimi**     | Code API (`api.kimi.com/coding/v1/usages`)         | Bearer key                           | 周/会话配额 + 月总量，兼容比例与旧计数格式    |
| **Moonshot** | balance (`api.moonshot.ai\|.cn`)                   | Bearer key                           | 余额（无窗口）                                |
| **Claude**   | OAuth usage (`api.anthropic.com/api/oauth/usage`)  | access token (+refresh)              | 5h/7d/全部模型/routines 窗口 + extra 花费     |
| **Codex**    | OAuth usage (`chatgpt.com/backend-api/wham/usage`) | access token + account id (+refresh) | 5h/7d/Spark 窗口 + Credits 余额与工作区月额度 |
| **Codex #2** | 同 Codex，独立槽位（第二个 ChatGPT 账号）          | 同 Codex                             | 同 Codex                                      |
| **Grok**     | CLI billing proxy，Bearer gRPC-web 作为后备        | Grok CLI access token                | 额度用量、重置时间、产品明细、套餐及预付余额  |
| **RightAPI** | account (`www.rightapi.ai/auth/me`)                | user token                           | 余额（无窗口）                                |

凭据获取方式见各 `providers/*.ts` 顶部注释。Claude/Codex 的 token 可从本机 `~/.claude/.credentials.json`、`~/.codex/auth.json` 复制粘贴。

Kimi 会话窗口按 API 实际时长显示，各窗口独立标记未知用量。Claude 模型周限额即使报告 `is_active=false` 也会显示，并按模型身份区分配额，避免误判重置。

Codex 额度使用原生 **Credits** 单位，同时展示月额度和独立购买的余额，不重复计算接口返回的同一月额度剩余值。如果工作区报告 spend controls 却没有可用月额度，则追加同账户的月用量查询，最多等待 6 秒；该可选查询失败不会影响主配额和余额。

Claude 和两个 Codex 槽位均识别永久 OAuth 续期失败，包括嵌套错误码。凭据被拒绝后暂停使用，替换凭据后恢复；临时故障仍按原有策略退避重试。成功续期时保存轮换后的 token 和服务端提供的有效期，Codex 不再假定固定 8 天有效期。

### Grok 凭据与用量

先运行 `grok login`，再从 `~/.grok/auth.json` 复制对应账户的 `key`
（通常位于 `https://auth.x.ai::<client-id>` 下，旧版位于 `https://accounts.x.ai/sign-in`）。
在凭据表单中选择 **Grok (SuperGrok 订阅)**，将其粘贴到 Access Token。
这里需要订阅登录 Token，不是 `xai-` API Key。可在表单中直接导入 `auth.json`，
自动填写 Access Token、Refresh Token、Client ID 和过期时间；多个账户时需选择一个。
文件在浏览器内解析，只提交所选账户续期需要的字段。也可以手动填写。

提供 Refresh Token 和 Client ID 后，看板会在用量轮询发现 Token 剩余不足 10 分钟时，
通过 `https://auth.x.ai/oauth2/token` 自动续期；401 时补做一次续期并重试用量查询。
新的 Access Token、Refresh Token 和服务端过期时间会一起加密保存。只填 Access Token
仍可查询，但过期后需要手动更新。过期时间以实际签发值为准，不固定为 6 小时或 7 天。

登录凭据应由一处管理续期：不要让 Grok CLI 和看板同时刷新同一份会轮换的 Refresh Token。
导入后，看板维护数据库中的副本，不回写本机 `auth.json`，不会跟随 CLI 的后续凭据更新。
建议使用由看板独立管理的登录会话。明确的 `invalid_grant` / `invalid_client` 会停止自动续期，
需重新登录并导入；网络错误和限流会退避重试，已有未过期 Token 仍会用于用量查询。

通过服务端 HTTP 管线读取订阅用量：

- 使用 Bearer Token 和 `x-xai-token-auth: xai-grok-cli` 请求 `https://cli-chat-proxy.grok.com/v1/billing?format=credits`。
- 账单请求失败或缺少用量时，以同一 Token 尝试 Grok 的 `GetGrokCreditsConfig` gRPC-web 接口。可选补充查询超时为 6 秒，失败不丢弃已有周期、套餐和余额。
- 缺少百分比时显示**未知**，保留已知重置时间；仅完整、有效的 gRPC 当前周期可以确认隐式零用量。
- 产品用量是总额度的组成部分，以文本展示；只有完整明细与同一响应的总用量吻合时才显示。预付余额独立展示，由美分换算为美元。

此接入不启动 Grok CLI、不导入浏览器 Cookie、不扫描本地会话，也不获取重置券。
同一服务进程内，轮询和手动刷新会合并请求；请保持单实例运行，避免多个实例同时轮换同一凭据。

可运行 `pnpm test` 验证离线 Provider、OAuth、HTTP 传输和卡片渲染测试，运行 `pnpm typecheck` 检查两个包的类型。

## 本地运行

```bash
cd quota-dashboard
pnpm install

# 生成开发用的 apps/web/.env：自动生成 APP_ENC_KEY / AUTH_SECRET /
# DASHBOARD_PASSWORD，并设置 AUTH_DISABLED=true 跳过登录。
# 可重复执行——已有 .env 不会被覆盖（要重新生成加 `-- --force`）。
pnpm setup:env

pnpm dev          # http://localhost:3000
```

想手动配置：`cp apps/web/.env.example apps/web/.env`，再把 `openssl rand -hex 32` 的结果填进 `APP_ENC_KEY`。

打开页面 → 点「+ 配置凭据」→ 选 provider、粘贴 key/token → 保存即抓取。后台每 `POLL_INTERVAL_SECONDS` 秒自动刷新。

如需排查 provider 返回的数据，可设置 `DEBUG=true`。每次抓取时，原始 quota API 响应体会输出到**服务端控制台**，不会通过看板 API 返回；响应可能包含账户数据，请勿在生产环境开启。

## 配额重置提醒

当某个速率窗口拿到新额度时（例如打满 100% 的 5 小时窗口翻篇、或周额度重置），轮询器可以推送一条提醒。检测在服务端对比相邻两次快照（同一窗口 used% 骤降），对所有产出速率窗口的 provider 都生效。

内置飞书群机器人：

1. 在飞书群里：设置 → 群机器人 → 添加「自定义机器人」，复制 webhook 地址（如开启了「签名校验」再复制密钥）。
2. 配置环境变量：

```bash
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxx
FEISHU_WEBHOOK_SECRET=   # 仅在开启签名校验时填写
NOTIFY_MIN_USED_PERCENT=80   # 仅提醒此前用量达到该百分比的窗口；0 = 每次重置都提醒（周窗口不受限，每次重置都会提醒）
```

3. 用 `POST /api/notify/test` 验证连通性（需要已登录的会话，可带上看板 cookie：`curl -X POST -b "qd_session=..." http://localhost:3000/api/notify/test`）。

配置了通知渠道后，服务启动时还会推送一条上线消息（可当作重启/存活信号）。

消息里的重置时间使用服务器时区，部署时请设置 `TZ`（如 `TZ=Asia/Shanghai`）。要接入其他渠道（Telegram、Slack 等），在 `apps/web/lib/notify/` 实现 `NotifyChannel` 接口并在 `notify/index.ts` 注册即可。

## 构建 / 部署

```bash
pnpm build        # next build（standalone 输出）
pnpm start        # 生产模式

# 或 Docker（常驻进程，支持后台轮询）
docker build -t quota-dashboard .
docker run -p 3000:3000 \
  -e APP_ENC_KEY=$(openssl rand -hex 32) \
  -v $(pwd)/data:/app/apps/web/data \
  quota-dashboard
```

> 自托管请跑成**常驻进程**（standalone / Docker），不要用 serverless —— 后台轮询与 token 刷新依赖长生命周期进程。

## 安全说明

内置了一套面向公网的加固：

- **鉴权（fail-closed）**：`middleware.ts` 拦截所有页面与 `/api/*`。需要 `DASHBOARD_PASSWORD` 登录，签发 HMAC 签名的 httpOnly session cookie。**未设置口令时一律拒绝访问**，避免裸奔上线。本地开发可设 `AUTH_DISABLED=true` 跳过。
- **限流**：进程内按 IP 限流，登录路径更严（防暴破）。读 `x-forwarded-for`，因此务必放在反向代理之后。
- **SSRF 防护**：用户提供的 Kimi / RightAPI `baseUrlOverride` 必须是公网 https，且会做字面量 + DNS 解析双重检查，拒绝私网 / 回环 / 云元数据地址。
- **凭据保护**：AES-256-GCM 加密后存 SQLite，**绝不回传前端**；`/api/usage` 只暴露 UI 所需字段（剔除原始上游响应 `extra`）。
- **CSRF**：session cookie 用 `sameSite=lax`，跨站发起的写请求不带 cookie，天然挡住。

### 公网部署清单（务必全做）

1. **TLS**：本服务只发 HTTP，必须放在反向代理（Caddy / Nginx / Cloudflare）后面终止 HTTPS——否则登录与凭据表单是明文上线。
2. 设置强 `DASHBOARD_PASSWORD` 与独立 `AUTH_SECRET`，保持 `AUTH_DISABLED` 关闭。
3. 反向代理正确透传 `X-Forwarded-For`（限流依赖它），并由代理设置安全响应头（HSTS 等）。
4. 仍建议叠加一层网络层防护（Cloudflare Access / IP 允许名单 / Tailscale），纵深防御。

> 残余风险：限流是单实例内存级（多实例需换 Redis）；SSRF 的 DNS 检查无法完全防 DNS-rebinding；主机被攻破则 `APP_ENC_KEY` 与库同在即等于明文。这些是非官方内部端点，字段可能漂移；对 claude.ai / chatgpt.com 的调用 ToS 敏感，请知悉风险。

## 扩展新 provider

1. 在 `packages/core/src/providers/` 新增 `xxx.ts`，实现 `ProviderFetchStrategy` 并导出 `ProviderDescriptor`。
2. 在 `providers/index.ts` 与 `registry.ts` 注册。
3. 在 `model.ts` 的 `UsageProvider` 联合类型里加上它。

UI 与后端无需改动 —— 表单字段、卡片展示都由 descriptor 元数据驱动。

## 说明 / 取舍

- 存储用 **better-sqlite3 直连 + 手写 SQL**（最少依赖、无迁移工具）；若需类型化查询 / 迁移可叠加 Drizzle。
- 历史快照已落 `snapshot_history` 表（`store.ts` 的 `historyFor`），可据此加 used% 历史曲线。
- cookie 抓取路径（claude.ai / chatgpt.com web、Kimi web）未包含在脚手架内 —— 见上游报告，属最脆弱、ToS 最敏感的一档，按需再加。
