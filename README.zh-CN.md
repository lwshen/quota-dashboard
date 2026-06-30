> [English](./README.md) | **中文**

# Quota Dashboard

在网页中展示 AI 服务商配额 / 用量的看板。复刻自 [CodexBar](https://github.com/steipete/CodexBar) 的配额获取机制 —— 把各家不同的用量接口归一化成统一的 `RateWindow` / `UsageSnapshot` 模型，由前端统一展示。

> **完全独立的子项目**：自带 pnpm workspace 与依赖，与外层仓库（Swift 的 CodexBar）无任何耦合。

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
│     └─ providers/        # kimi / moonshot / claude / codex
└─ apps/web/               # Next.js 看板 + 后端代理
   ├─ app/                 # 页面 + API routes
   ├─ components/          # ProviderCard / RateWindowBar / 表单
   └─ lib/                 # db / crypto / store / fetcher / poller
```

## 已实现的 provider

| Provider | 路径 | 凭据 | 产出 |
|---|---|---|---|
| **Kimi** | Code API (`api.kimi.com/coding/v1/usages`) | Bearer key | 周用量 + 5h 速率窗口 |
| **Moonshot** | balance (`api.moonshot.ai\|.cn`) | Bearer key | 余额（无窗口） |
| **Claude** | OAuth usage (`api.anthropic.com/api/oauth/usage`) | access token (+refresh) | 5h/7d/模型/routines 窗口 + extra 花费 |
| **Codex** | OAuth usage (`chatgpt.com/backend-api/wham/usage`) | access token + account id (+refresh) | 5h/7d 窗口 + credits |

凭据获取方式见各 `providers/*.ts` 顶部注释。Claude/Codex 的 token 可从本机 `~/.claude/.credentials.json`、`~/.codex/auth.json` 复制粘贴。

## 本地运行

```bash
cd quota-dashboard
pnpm install

# 配置环境变量
cp apps/web/.env.example apps/web/.env
# 生成加密主密钥并填入 APP_ENC_KEY
openssl rand -hex 32

pnpm dev          # http://localhost:3000
```

打开页面 → 点「+ 配置凭据」→ 选 provider、粘贴 key/token → 保存即抓取。后台每 `POLL_INTERVAL_SECONDS` 秒自动刷新。

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
- **SSRF 防护**：用户提供的 Kimi `baseUrlOverride` 必须是公网 https，且会做字面量 + DNS 解析双重检查，拒绝私网 / 回环 / 云元数据地址。
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
