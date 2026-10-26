# CodexBar 对照评估

评估日期：2026-10-23。对照本地代码和提交历史，未查询或更新远端仓库。

更新状态（2026-10-25）：高、中优先级的四组问题已修复，新增 provider、OAuth 和卡片渲染回归测试。下文保留修复前的评估依据；“后续增强项”仍作为后续工作。

- 参考项目：`~/workspace/codexbar`，`575a2446a50113b9afa5156d64915dc94ee19045`。
- 当前项目：`3caf0f70642f82bd3e02e37bb1d7d4d56e40bc47`。
- 范围：已接入 provider 的接口兼容性、令牌续期、用量展示，以及适合网页服务的功能增强。
- 验证：现有 39 项测试全部通过；两个包的类型检查通过；另以临时脚本和合成响应离线复现了下列 8 个差异。临时构建已清理，未调用真实账户接口。

## 优先处理：Kimi 与 Claude 配额兼容性

### 1. Kimi 比例配额、月总量与实际窗口时长

当前 `packages/core/src/providers/kimi.ts:60` 只读取 `usage` 和 `limits[0].detail`，并在第 80 行把速率窗口写死为 300 分钟。

CodexBar 已支持同一 Code API 的另一种响应：

```json
{
  "usages": {
    "limit_7d": { "used_ratio": 0.125 },
    "limit_5h": { "used_ratio": 0.625 },
    "limit_month_total": { "used_ratio": 0.42 }
  }
}
```

离线复现：当前项目返回空的主、次窗口，也没有月窗口；上述响应应分别提供 12.5%、62.5%、42% 的用量。另一个计数格式样例明确报告 2 小时窗口，当前项目仍归一化为 5 小时。

建议兼容比例和旧计数两种格式，补月总量窗口，并读取 `window.duration` / `timeUnit`。同时沿用上游对比例与计数冲突、缺失数据的判断，保持当前“周用量为主窗口、短时配额为次窗口”的顺序。

对应参考：

- `Sources/CodexBarCore/Providers/Kimi/KimiModels.swift`：`KimiCodeUsagePools`、`KimiRatioPool`、`KimiWindow`。
- `Sources/CodexBarCore/Providers/Kimi/KimiUsageSnapshot.swift`：`toUsageSnapshot`。
- `Tests/CodexBarTests/KimiRatioPoolTests.swift`、`KimiContradictoryUsageTests.swift`。
- 相关提交：`51ed16bdd`，支持 Code API ratio quota pools。

### 2. Claude 模型周限额不能按 is_active 过滤

当前 `packages/core/src/providers/claude.ts:40` 用 `find` 取首个 `weekly_scoped && is_active === true` 条目。

CodexBar 明确记录：实际生效的 scoped limit 也可能报告 `is_active=false`；它逐条映射有效模型周限额，并按模型生成稳定 ID。

离线复现：

- 一个有效的 `is_active=false` 模型周限额被完全丢弃。
- 两个有效的 `is_active=true` 模型周限额只保留第一个。

建议遍历全部条目，检查 kind、group、有效百分比及模型信息，跳过 all-models 重复项，并按模型去重。使用稳定的模型 ID 后，应同步检查 `reset.ts` 的窗口身份比较，防止模型轮换造成误通知。

对应参考：

- `Sources/CodexBarCore/Providers/Claude/ClaudeScopedWeeklyLimitMapper.swift`。
- `Sources/CodexBarCore/Providers/Claude/ClaudeWeb/ClaudeWebExtraRateWindowParser.swift`。
- `Sources/CodexBarCore/Providers/Claude/ClaudeUsageFetcher.swift:1070`。
- `Tests/CodexBarTests/ClaudeOAuthTests.swift:185`。
- 相关提交：`e1325bfd6`，OAuth/Web 共用逐条解析器。

## 随后处理：Codex 展示完整性与续期错误

### 3. 补全 Spark 周窗口、Credits 单位和工作区月限额

当前 `packages/core/src/providers/codex.ts:74` 在额外限额的主、次窗口之间二选一。CodexBar 对 Spark 分别映射 5 小时和每周窗口。

另外，第 84 行把 Codex credits 标为 USD，并借用 `limit` 存余额；上游用 `Credits` 标记单位，并区分余额与月限额。当前项目也没有解析 `individual_limit` 或 `spend_control.individual_limit`。

离线复现：

- Spark 同时返回 5 小时、7 天窗口时，只展示前者。
- `credits.balance="25"` 被标为 USD，而不是 Credits。
- 工作区月额度 `used=250, limit=1000` 没有生成费用/额度信息。

建议先补这三处解析。余额可复用现有 `ProviderCostSnapshot.balance`；零余额应明确显示 0，避免目前 `limit=0` 落入通用无限额显示逻辑。若一个账户同时有月限额和独立余额，需同步调整卡片，展示两者。

对应参考：

- `Sources/CodexBarCore/Providers/Codex/CodexAdditionalRateLimitMapper.swift`。
- `Sources/CodexBarCore/Providers/Codex/CodexExtraUsageCost.swift`。
- `Sources/CodexBarCore/Providers/Codex/CodexOAuth/CodexOAuthUsageFetcher.swift:72`。
- `Sources/CodexBarCore/Providers/Codex/CodexSpendControlsMonthlyUsage.swift`：仅对符合条件的工作区追加月用量查询，并尊重未启用限额的 enforcement mode。
- 当前展示位置：`apps/web/components/ProviderCard.tsx:18`。

### 4. 统一识别永久失效的刷新令牌

CodexBar 的 `CodexTokenRefresher` 同时识别字符串 `error`、`error.code` 及顶层 `code`。

当前 `packages/core/src/providers/codex.ts:128` 直接将 `j.error` 转为字符串。离线输入 `{"error":{"code":"refresh_token_reused"}}` 时得到 `UpstreamError`，未识别为需要重新登录的永久错误。

此外，当前通用续期协调器仅对 `RefreshRejectedError` 设置持久化阻断；Codex 和 Claude 的永久失败仍抛 `UnauthorizedError`。因此，即使识别出了永久失效，后续轮询仍会在退避结束后重试。

建议扩展错误码解析，并让 Codex/Claude 的明确永久错误复用 Grok 已使用的 `RefreshRejectedError`。保留网络故障、限流等暂时错误的退避重试；为两家 provider 补专门的续期测试。

对应位置：

- 上游：`Sources/CodexBarCore/Providers/Codex/CodexOAuth/CodexTokenRefresher.swift`。
- 当前：`packages/core/src/providers/codex.ts:126`、`packages/core/src/providers/claude.ts:139`、`packages/core/src/usage-fetcher.ts:74`。

## 后续增强项

这些是可移植能力或静态代码层面的改进建议，未包含在上述 8 个离线复现场景中。

1. **更完整的重置次数信息。** 当前 Codex 只读取 usage 根节点的 `rate_limit_reset_credits`；上游还会独立查询 `/wham/rate-limit-reset-credits`。Claude 则支持带 `cedar_ember=1` 的 usage 查询及不支持时的回退。应作为可选补全，补全失败不能丢弃基本用量。
2. **历史曲线与用量节奏。** 当前 `snapshot_history` 已存历史，但页面没有历史曲线或“是否足够用到重置”的提示。可参考上游 `UsagePace.swift`、`QuotaBurndownModel.swift`，先增加历史 API 和基础曲线，再增加有明确数据依据的节奏提示。历史表目前持续插入，可同时加按时间或条数的保留策略。
3. **抓取失败时保留上次成功值。** 当前失败会以空 snapshot 覆盖卡片数据。可保留同一账户的上次成功值，同时标明数据时间和最新错误；凭据替换时应清除旧账户数据。展示层也需调整，因为 `ProviderCard` 当前只在没有可展示数据时进入错误状态。
4. **按窗口判断数据可信度。** 核心模型和重置检测已有 `usageKnown`，但 `ProviderCard` 的主、次、第三窗口主要依赖整份 snapshot 的 `dataConfidence`。Kimi 一个窗口已知、另一个未知时可能显示不准确，可在兼容性更新时一起修正。
5. **按实际需要增加 provider。** CodexBar 提供大量 API key、Cookie、CLI 和本地应用数据源。网页服务适合优先复用服务器可直接访问的接口；浏览器、Keychain、桌面会话和本地日志路径需要另行设计。最近的 Kimi gift balance 更新属于额外订阅信息，当前仅有 Code API key 的路径不能直接获得它。

## Grok 现状

当前已经实现代理缺少用量时的 6 秒可选 gRPC 补全、经过有效周期验证的隐式零用量、代理重置/套餐元数据保留，以及续期和并发去重，并有相应测试。

上游 `ad0c5679b` 的近期零用量修复主要让 ACP 成功路径也进入既有补全逻辑；当前项目没有 ACP 路径，因此没有同样的遗漏。`d82bddb55` 的 `_x.ai/billing` 方法名修改也属于 ACP，不需要直接迁入当前 HTTP 路径。

这只是本地实现与离线测试的判断，未验证真实账户接口当前是否可用；上游也将 grok.com gRPC 标为 best-effort。

## 建议实施顺序

1. Kimi 格式兼容与 Claude 全量模型周限额，并补对应离线测试。
2. Codex Spark 周窗口、Credits 单位、月限额，以及 Codex/Claude 永久续期失败处理。
3. 独立重置次数补全、失败时保留数据、历史曲线与用量节奏。

最初评估仅新增本文档；2026-10-25 已实施高、中优先级修复，详情见同分支代码、测试及中英文 README。
