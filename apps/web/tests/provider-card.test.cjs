const { test } = require("node:test");
const assert = require("node:assert/strict");
const { join } = require("node:path");
const { createWebLoader, webRequire } = require("./helpers/load-web.cjs");
const React = webRequire("react");
const { renderToStaticMarkup } = webRequire("react-dom/server");
const core = require(join(process.env.QUOTA_TEST_BUILD_DIR, "index.js"));

const { load } = createWebLoader();
const { ProviderCard } = load("components/dashboard/ProviderCard.tsx");
const { formatCost, laneMeta } = load("shared/format.ts");
const now = new Date("2026-10-25T12:00:00Z");
const render = (snapshot) => renderToStaticMarkup(React.createElement(ProviderCard, {
  view: { provider: snapshot.provider, label: snapshot.provider, snapshot, error: null, fetchedAt: now.toISOString() },
  now: now.getTime(), authed: true,
}));
async function parse(provider, body) {
  return core.runPipeline(core.getDescriptor(provider), "auto", { bearerToken: "synthetic" }, {
    now, http: { get: async () => ({ status: 200, body: JSON.stringify(body), headers: {} }) },
  });
}

test("card shows actual Kimi duration and trusts each window independently", async () => {
  const snapshot = await parse("kimi", { usage: { limit: "100" }, limits: [{ window: { duration: 2, timeUnit: "TIME_UNIT_HOUR" }, detail: { limit: "100", used: "20" } }] });
  const html = render(snapshot);
  assert.match(html, /2小时速率/);
  assert.match(html, /未知 · unknown/);
  assert.match(html, /20%/);
  assert.equal((html.match(/class="bar"/g) ?? []).length, 1);
  assert.equal(laneMeta("kimi", "secondary", null).title, "速率");
  assert.deepEqual(laneMeta("antigravity", "primary"), { title: "Gemini 模型", sub: "Gemini" });
  assert.deepEqual(laneMeta("antigravity", "secondary"), { title: "Claude / GPT", sub: "Claude/GPT" });
});

test("card renders ratio-only Kimi monthly quota and every inactive Claude model quota", async () => {
  assert.match(render(await parse("kimi", { usages: { limit_month_total: { used_ratio: 0.42 } } })), /42%/);
  const snapshot = await parse("claude", { limits: ["Fable", "Example Model"].map((name) => ({
    kind: "weekly_scoped", group: "weekly", percent: 25, is_active: false, scope: { model: { display_name: name } },
  })) });
  const html = render(snapshot);
  assert.match(html, /Fable \(7d\)/);
  assert.match(html, /Example Model \(7d\)/);
});

test("card shows zero credits as zero and preserves both monthly quota and independent balance", async () => {
  const empty = render(await parse("codex", { credits: { has_credits: true, balance: 0 } }));
  assert.match(empty, /0\.00 Credits/);
  assert.doesNotMatch(empty, /∞|USD/);
  const combined = render(await parse("codex2", { individual_limit: { limit: 1000, used: 250 }, credits: { has_credits: true, balance: 40 } }));
  assert.match(combined, /250\.00 \/ 1000\.00 Credits/);
  assert.match(combined, /余额 40\.00 Credits/);
  assert.equal(formatCost({ limit: 0, used: 0, balance: 0, currencyCode: "USD" }), "0.00 USD");
  assert.equal(formatCost({ limit: 25, used: 0, currencyCode: "USD", period: "Credits balance" }), "25.00 USD");
  assert.equal(formatCost({ limit: 0, used: 0, currencyCode: "USD", period: "Credits balance" }), "0.00 USD");
});

test("Codex cards show reset-credit expiry in local time with and without quota windows", () => {
  const expiresAt = "2026-11-10T12:00:00.000Z";
  for (const provider of ["codex", "codex2"]) {
    for (const primary of [null, { usedPercent: 25, windowMinutes: 300 }]) {
      const snapshot = { provider, primary, secondary: null, tertiary: null, dataConfidence: "exact",
        identity: { loginMethod: "Plan: pro · 重置次数: 2", resetCreditsExpireAt: expiresAt } };
      const html = render(snapshot);
      assert.match(html, /重置次数最近到期：/);
      assert.match(html, /<time dateTime="2026-11-10T12:00:00.000Z">/);
      assert.ok(html.includes(new Date(expiresAt).toLocaleString("zh-CN", {
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
        second: "2-digit", hour12: false, timeZoneName: "short",
      })));
      for (const resetCreditsExpireAt of [undefined, null, "invalid"]) {
        assert.doesNotMatch(render({ ...snapshot, identity: { ...snapshot.identity, resetCreditsExpireAt } }), /重置次数最近到期/);
      }
    }
  }
});
