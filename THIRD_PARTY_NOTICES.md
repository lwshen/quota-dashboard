# CodexBar

The Grok billing implementation in `packages/core/src/providers/grok*.ts` and
related test cases are adapted from CodexBar's GrokCreditsProxyFetcher,
GrokWebBillingFetcher, GrokProtobufField, GrokPlan, GrokCredentialRouting,
GrokProviderDescriptor, and their tests.

The Kimi ratio/count reconciliation, Claude scoped weekly limits, Codex Spark
windows and credit-limit mapping, and related regression tests are also adapted
from CodexBar's KimiUsageSnapshot, KimiRatioPoolTests,
KimiContradictoryUsageTests, ClaudeScopedWeeklyLimitMapper,
CodexAdditionalRateLimitMapper, CodexSpendControlLimitMapping,
CodexSpendControlsMonthlyUsage, CodexExtraUsageCost, and CodexTokenRefresher.

Source: https://github.com/steipete/CodexBar

MIT License

Copyright (c) 2026 Peter Steinberger

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
