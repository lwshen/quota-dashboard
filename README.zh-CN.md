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
├─ packages/core/          # 统一模型、服务商适配、OAuth 与 HTTP（不依赖框架）
│  ├─ src/providers/       # antigravity / kimi / moonshot / claude / codex / grok / rightapi
│  └─ tests/               # 离线协议与采集测试
├─ apps/web/
│  ├─ app/                 # 页面和 API 路由
│  ├─ components/          # accounts / auth / dashboard / layout 功能组件
│  ├─ client/              # 浏览器交互 hooks
│  ├─ shared/              # 纯计算、格式化、接口类型、JSON 导入
│  ├─ runtime/             # Edge / Node 共用配置与会话鉴权
│  ├─ server/              # credentials / security / storage / usage / notify
│  └─ tests/               # API、SQLite、通知、渲染回归测试
├─ scripts/                # 环境初始化、统一测试、模块依赖边界检查
└─ docs/                   # 架构维护指南和功能截图
```

职责划分、依赖规则和后续维护入口见[项目结构与维护指南](./docs/architecture.zh-CN.md)。

## 已实现的 provider

| Provider        | 路径                                               | 凭据                                   | 产出                                              |
| --------------- | -------------------------------------------------- | -------------------------------------- | ------------------------------------------------- |
| **Kimi**        | Code API (`api.kimi.com/coding/v1/usages`)         | Bearer key                             | 周/会话配额 + 月总量，兼容比例与旧计数格式        |
| **Moonshot**    | balance (`api.moonshot.ai\|.cn`)                   | Bearer key                             | 余额（无窗口）                                    |
| **Claude**      | OAuth usage (`api.anthropic.com/api/oauth/usage`)  | access token (+refresh)                | 5h/7d/全部模型/routines 窗口 + extra 花费         |
| **Codex**       | OAuth usage (`chatgpt.com/backend-api/wham/usage`) | access token + account id (+refresh)   | 5h/7d/Spark 窗口 + Credits 余额与工作区月额度     |
| **Antigravity** | Google Cloud Code (`cloudcode-pa.googleapis.com`)  | Google OAuth token (+refresh + secret) | Gemini 与 Claude/GPT 5h/周配额窗口 + 模型配额回退 |
| **Grok**        | CLI billing proxy，Bearer gRPC-web 作为后备        | Grok CLI access token                  | 额度用量、重置时间、产品明细、套餐及预付余额      |
| **RightAPI**    | account (`www.rightapi.ai/auth/me`)                | user token                             | 余额（无窗口）                                    |

凭据获取方式见各 `providers/*.ts` 顶部注释。在账号配置中，Claude 和所有 Codex 账号均支持选择 JSON 文件或粘贴 JSON 字符串，可使用本机 `~/.claude/.credentials.json`、`~/.codex/auth.json` 的完整内容、其中的 `claudeAiOauth` / `tokens` 对象，或扁平的 Token 对象。导入后会填入表单供检查，包含可用的 Refresh Token 和 Codex Account ID，检查后再保存。JSON 在浏览器内解析（最大 1 MB），保存时仅提交支持的凭据字段，也可继续手动填写。

Kimi 会话窗口按 API 实际时长显示，各窗口独立标记未知用量。Claude 模型周限额即使报告 `is_active=false` 也会显示，并按模型身份区分配额，避免误判重置。

Codex 额度使用原生 **Credits** 单位，同时展示月额度和独立购买的余额，不重复计算接口返回的同一月额度剩余值。如果工作区报告 spend controls 却没有可用月额度，则追加同账户的月用量查询，最多等待 6 秒；该可选查询失败不会影响主配额和余额。

Claude 和所有 Codex 账号均识别永久 OAuth 续期失败，包括嵌套错误码。凭据被拒绝后暂停使用，替换凭据后恢复；临时故障仍按原有策略退避重试。成功续期时保存轮换后的 token 和服务端提供的有效期，Codex 不再假定固定 8 天有效期。

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

## 多账号管理

管理员登录后，打开顶部「账号管理」，点击「新增账号」，选择服务商并填写别名，可选择已有分组或输入新分组，然后配置该账号的凭据。同一服务商可以自由添加多个账号，Codex 不再限制为两个槽位。别名与分组各最多 80 字，可使用相同别名；各账号由独立 ID 区分。

首页按分组展示账号卡片（未设置分组的显示为「未分组」）。账号详情支持修改别名、分组、配置凭据和单独获取用量；列表支持按分组、待配置或获取失败筛选。别名与分组会显示在公开只读看板，账户邮箱、余额等仍遵循管理员可见规则。

每个账号独立保存凭据、OAuth 续期状态、用量、历史记录和通知冷却。更改别名或分组不会清除这些数据。停用账号只影响该账号的显示、轮询和提醒，凭据与历史保留；重新保存凭据不会自动启用账号。删除账号需要在详情中确认，只清除该账号的数据，不影响同服务商的其他账号。`ENABLE_POLLER=false` 仍会全局关闭后台轮询。

升级时自动迁移已保存的旧渠道记录：原 `codex` / `codex2` 保留原存储 ID，均归类为 Codex，默认别名为「Codex」／「Codex #2」；其他已配置渠道也迁移为普通账号。凭据密文、历史数据、启停设置和提醒状态保留，无需重新导入；迁移可重复执行，不会重复创建账号或恢复已删除账号。全新数据库不预置固定账号。

管理接口 `GET/POST/PATCH/DELETE /api/accounts` 仅管理员可用；凭据、定向刷新和历史请求使用账号的 `accountId`。此 ID 是看板账号 ID，与凭据字段中的 ChatGPT Account ID 不同。`GET /api/providers` 只列出服务商模板，不再列出独立的 Codex #2 模板。旧请求中的 `provider` 参数仍兼容迁移前的存储 ID。

凭据填写后直接保存，无需选择保存方式。重新保存已有渠道时，需要填写完整凭据；本次提交会覆盖原凭据，可选字段留空会清除旧值，并清除旧的用量快照和历史记录，避免混用不同账户的 Token。切换渠道、返回列表或关闭面板时，未保存的输入会清空，不会写入浏览器存储。

停用渠道只会「保存凭据」，不会抓取。保存后可点击「启用并获取用量」；已启用的渠道可以「重新获取用量」，失败后可直接重试，无需重新提交凭据。

如需排查 provider 返回的数据，可设置 `DEBUG=true`。每次抓取时，原始 quota API 响应体会输出到**服务端控制台**，不会通过看板 API 返回；响应可能包含账户数据，请勿在生产环境开启。

## 历史曲线

点击账号卡片底部的「历史曲线」，可切换近 24 小时、7 天和 30 天，选择不同配额窗口，并查看最近记录、最低值和最高值。图中圆点标记检测到的配额重置，悬停或聚焦图表后按左右方向键可查看采样时间与数值。时间使用浏览器本地时区。

历史直接读取已有的 `snapshot_history`，无需重新配置凭据。未知用量、窗口消失和超过正常采集间隔的空档会断线显示；不同模型或时长的窗口分开记录。长时间范围按时间分桶保留端点、峰值、低值和重置点，避免向浏览器发送全部原始快照。只有一条有效记录时显示单点，尚无数据时显示空状态。

余额和周期已用金额仅管理员可见，支持 Credits 及各渠道原有的计价单位，包括 Moonshot / RightAPI 的旧余额快照；访客只能查看配额比例历史。接口 `GET /api/history?accountId=<账号ID>&range=24h` 接受 `24h`、`7d`、`30d`，不返回账户身份或原始上游响应，停用渠道不可查询。

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

消息里的重置时间使用服务器时区，部署时请设置 `TZ`（如 `TZ=Asia/Shanghai`）。要接入其他渠道（Telegram、Slack 等），在 `apps/web/server/notify/` 实现 `NotifyChannel` 接口并在 `notify/index.ts` 注册即可。

## 额度不足与渠道异常提醒

配置上述飞书机器人后，后台采集和手动刷新均会检查额度与渠道状态，默认启用以下提醒：

- **额度不足**：已知用量达到 **80%** 或 **95%** 时分级提醒，适用于配额窗口和有明确上限的周期用量。未知用量、无上限额度和产品组成占比不会触发。模型、窗口时长及余额单位分别处理。
- **连续失败**：连续 **3 次**获取失败后提醒；一次成功获取会清零失败计数。上游限流会作为获取异常处理。
- **凭据异常**：用量接口拒绝凭据，或 OAuth 续期明确永久失效时立即提醒，并提示检查 Token／权限或重新登录导入。正常自动续期、短暂续期故障且仍可获取用量时不会误报。
- **数据过期**：后台轮询期间，距最后成功获取超过 **30 分钟**时提醒，实际阈值不小于三个轮询周期。已有获取异常／凭据提醒时不重复添加过期提醒。此检查需要看板进程仍在运行。
- **恢复通知**：成功获取用量后，向此前成功收到渠道异常提醒的通知渠道发送一次恢复消息。

同一渠道的一次采集触发多个预警时合并发送。相同指标、通知渠道的未解决预警默认每 **6 小时**最多重复一次，达到更高百分比或升级为凭据问题时立即提醒；低于阈值后短时间再次越线仍受冷却限制。去重、失败计数与投递状态保存在 SQLite 的 `notification_alert_state` 表，重启后继续有效。发送失败不会记为已送达，下次采集会重试；每个通知渠道独立记录结果。

余额阈值默认关闭，需按服务商的原始单位单独配置（同一服务商的所有账号共享阈值，通知去重按账号隔离）。例如 Codex 的单位是 Credits，Moonshot 随地区为美元或人民币，不做币种换算：

```dotenv
NOTIFY_ALERTS_ENABLED=true
NOTIFY_USAGE_THRESHOLDS=80,95
NOTIFY_BALANCE_THRESHOLDS={"moonshot":5,"rightapi":5,"codex":100}
NOTIFY_FAILURE_THRESHOLD=3
NOTIFY_COOLDOWN_SECONDS=21600
NOTIFY_STALE_SECONDS=1800
NOTIFY_RECOVERY=true
DASHBOARD_URL=https://quota.example.com
```

`NOTIFY_USAGE_THRESHOLDS` 留空关闭百分比预警，`NOTIFY_BALANCE_THRESHOLDS={}` 关闭余额预警；余额小于或等于阈值时触发，支持零余额和负余额。`NOTIFY_ALERTS_ENABLED=false` 关闭本节新增提醒，保留原有的重置／启动／测试通知；`NOTIFY_RECOVERY=false` 单独关闭恢复通知。修改环境变量后重启生效。

未配置凭据或停用的渠道不提醒。停用、删除或替换整套凭据会清除该渠道提醒状态；同账户手动更新凭据会重新开始异常计数并保留用量预警冷却，自动 OAuth 轮换不清除状态。提醒只包含渠道、用量和固定的处理建议，不发送账户身份、Token 或上游原始错误正文；可选的 `DASHBOARD_URL` 提供返回看板的链接，不会作为服务端请求目标。

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
- 历史快照落 `snapshot_history` 表；重置提醒使用最近快照，历史曲线按时间范围流式读取并压缩为关键采样点。
- cookie 抓取路径（claude.ai / chatgpt.com web、Kimi web）未包含在脚手架内 —— 见上游报告，属最脆弱、ToS 最敏感的一档，按需再加。
