const { test } = require("node:test");
const assert = require("node:assert/strict");
const { join } = require("node:path");
const core = require(join(process.env.QUOTA_TEST_BUILD_DIR, "index.js"));
const now = new Date("2026-10-25T12:00:00Z");
const reset = "2026-10-30T12:00:00.000Z";

async function fetch(provider, body, creds = {}, ...responses) {
  const calls = [];
  const queue = [body, ...responses];
  const http = { get: async (...args) => {
    calls.push(args);
    const next = queue.shift();
    if (next instanceof Error) throw next;
    assert.ok(next, "unexpected upstream request");
    return { status: next.status ?? 200, headers: {}, body: JSON.stringify(next.body ?? next) };
  } };
  const snapshot = await core.runPipeline(core.getDescriptor(provider), "auto", { bearerToken: "synthetic", ...creds }, { now, http });
  return { snapshot, calls };
}
const count = (used, extra = {}) => ({ limit: "100", used: String(used), resetTime: reset, ...extra });
const scoped = (name, extra = {}) => ({ kind: "weekly_scoped", group: "weekly", percent: 25,
  is_active: false, scope: { model: { id: name.toLowerCase(), display_name: name } }, resets_at: reset, ...extra });
const window = (seconds, used = 25) => ({ limit_window_seconds: seconds, used_percent: used, reset_at: 1793361600 });

test("Kimi maps ratio-only weekly, session and monthly pools without inventing counts", async () => {
  const { snapshot: s } = await fetch("kimi", { usages: {
    limit_7d: { used_ratio: 0.125, reset_time: reset }, limit_5h: { used_ratio: 0.625 },
    limit_month_total: { used_ratio: 0.42, reset_time: reset }, limit_month_code: { used_ratio: 0.01 },
  } });
  assert.equal(s.primary.usedPercent, 12.5);
  assert.equal(s.primary.windowMinutes, 10080);
  assert.equal(s.secondary.usedPercent, 62.5);
  assert.equal(s.secondary.windowMinutes, 300);
  assert.equal(s.extraRateWindows.length, 1);
  assert.equal(s.extraRateWindows[0].window.usedPercent, 42);
  assert.equal(s.extraRateWindows[0].window.windowMinutes, null);
  assert.equal(s.dataConfidence, "exact");
});

test("Kimi supports monthly-only and session-only responses without fabricating weekly usage", async () => {
  for (const body of [{ usages: { limit_month_total: { used_ratio: 1.05 } } }, { limits: [{ detail: count(20) }] }]) {
    const { snapshot: s } = await fetch("kimi", body);
    assert.equal(s.primary, null);
    assert.equal(s.dataConfidence, "exact");
    assert.equal(s.secondary?.usedPercent ?? s.extraRateWindows[0].window.usedPercent, body.limits ? 20 : 100);
  }
});

test("Kimi converts duration units and withholds invalid durations", async () => {
  for (const [duration, timeUnit, expected] of [[2, "TIME_UNIT_HOUR", 120], [90, "TIME_UNIT_MINUTE", 90],
    [1, "TIME_UNIT_DAY", 1440], [5, "unknown", null], [0, "TIME_UNIT_HOUR", null], [-1, "TIME_UNIT_HOUR", null]]) {
    const { snapshot: s } = await fetch("kimi", { limits: [{ detail: count(20), window: { duration, timeUnit } }] });
    assert.equal(s.secondary.windowMinutes, expected);
  }
});

test("Kimi matching exhausted counts override a contradictory zero ratio", async () => {
  const { snapshot: s } = await fetch("kimi", { limits: [{ detail: count(100), window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" } }],
    usages: { limit_5h: { used_ratio: 0, reset_time: "2026-10-30T11:59:59Z" }, limit_month_total: { used_ratio: 0.5531 } } });
  assert.equal(s.primary, null);
  assert.equal(s.secondary.usedPercent, 100);
  assert.equal(s.extraRateWindows[0].window.usedPercent, 55.31);
});

test("Kimi counts from a different reset or duration cannot override ratios", async () => {
  for (const [duration, resetTime] of [[120, reset], [300, "2026-11-01T12:00:00Z"], [300, null]]) {
    const { snapshot: s } = await fetch("kimi", { limits: [{ detail: count(100, { resetTime }), window: { duration, timeUnit: "TIME_UNIT_MINUTE" } }],
      usages: { limit_5h: { used_ratio: 0, reset_time: reset } } });
    assert.equal(s.secondary.usedPercent, 0);
    assert.equal(s.secondary.windowMinutes, 300);
  }
});

test("Kimi rejects invalid ratio scalars, falls back to counts, and marks missing counts unknown", async () => {
  for (const ratio of [-1, true, "Infinity", "", null]) {
    const { snapshot: s } = await fetch("kimi", { usage: count(20), usages: { limit_7d: { used_ratio: ratio } } });
    assert.equal(s.primary.usedPercent, 20);
  }
  const { snapshot: s } = await fetch("kimi", { usage: { limit: "100" }, limits: [{ detail: { limit: "100", remaining: "60" } }] });
  assert.equal(s.primary.usageKnown, false);
  assert.equal(s.primary.windowMinutes, null);
  assert.equal(s.secondary.usedPercent, 40);
  assert.equal(s.secondary.usageKnown, true);
  await assert.rejects(fetch("kimi", { usages: { unknown_pool: { used_ratio: 0.1 } } }), /no supported quota windows/);
});

test("Claude preserves inactive and multiple scoped models, skipping bad siblings and all-models duplicates", async () => {
  const { snapshot: s } = await fetch("claude", { five_hour: { utilization: 10 }, limits: [null, false, "bad", [],
    scoped("Fable"), scoped("Example Model", { is_active: true }), scoped("Fable"), scoped("All Models"),
    scoped("Invalid", { percent: true }), scoped("Empty", { scope: {} }), scoped("Wrong group", { group: "daily" })] });
  assert.deepEqual(s.extraRateWindows.map((w) => w.id), ["claude-weekly-scoped-fable", "claude-weekly-scoped-example-model"]);
  assert.equal(s.extraRateWindows[0].window.usedPercent, 25);
  assert.equal(s.extraRateWindows[0].window.windowMinutes, 10080);
});

test("Claude model identity remains stable across label changes and separates reset comparisons", async () => {
  const first = (await fetch("claude", { limits: [scoped("Fable")] })).snapshot;
  const second = (await fetch("claude", { limits: [scoped("Other Model", { percent: 0, resets_at: "2026-11-06T12:00:00Z" })] })).snapshot;
  assert.deepEqual(core.detectQuotaResets(first, second), []);
  const renamed = scoped("Renamed", { scope: { model: { id: "fable", display_name: "Renamed" } } });
  assert.equal((await fetch("claude", { limits: [renamed] })).snapshot.extraRateWindows[0].id, first.extraRateWindows[0].id);
  const resetWindow = scoped("Fable", { percent: 0, resets_at: "2026-11-06T12:00:00Z" });
  assert.equal(core.detectQuotaResets(first, (await fetch("claude", { limits: [resetWindow] })).snapshot).length, 1);
});

test("Codex and Codex #2 preserve both Spark windows and isolate malformed siblings", async () => {
  for (const provider of ["codex", "codex2"]) {
    const { snapshot: s } = await fetch(provider, { rate_limit: { primary_window: window(18000, 10) }, additional_rate_limits: [null,
      { limit_name: "Spark", metered_feature: "codex-spark", rate_limit: { primary_window: window(18000, 25), secondary_window: window(604800, 70) } },
      { limit_name: "Renamed Spark", rate_limit: { secondary_window: window(604800, 70) } },
      { limit_name: "Other", rate_limit: { primary_window: { used_percent: true }, secondary_window: window(18000, 30) } }] });
    assert.equal(s.provider, provider);
    assert.equal(s.primary.usedPercent, 10);
    assert.deepEqual(s.extraRateWindows.map((w) => [w.id, w.window.windowMinutes]), [["codex-spark", 300], ["codex-spark-weekly", 10080], ["codex-other", 300]]);
  }
});

test("Codex classifies reversed Spark windows by actual duration", async () => {
  const { snapshot: s } = await fetch("codex", { additional_rate_limits: [{ limit_name: "Spark", rate_limit: {
    primary_window: window(604800, 70), secondary_window: window(18000, 10),
  } }] });
  assert.deepEqual(s.extraRateWindows.map((w) => w.id), ["codex-spark-weekly", "codex-spark"]);
});

test("Codex credits retain their native unit and explicitly represent zero balance", async () => {
  for (const balance of ["25", "0"]) {
    const { snapshot: s } = await fetch("codex", { credits: { has_credits: true, unlimited: false, balance } });
    assert.equal(s.providerCost.currencyCode, "Credits");
    assert.equal(s.providerCost.balance, Number(balance));
    assert.equal(s.providerCost.limit, 0);
  }
  for (const balance of [null, "invalid", "", -1, true, "Infinity"]) {
    assert.equal((await fetch("codex", { credits: { has_credits: true, balance } })).snapshot.providerCost, null);
  }
});

test("Codex resolves root, rate-limit and spend-control caps with balance kept separate", async () => {
  const { snapshot: s } = await fetch("codex", {
    individual_limit: { limit: "1000", used: "250", reset_at: 1793361600 }, rate_limit: { individual_limit: { limit: 2000, used: 500 } },
    spend_control: { individual_limit: { limit: 3000, used: 750 } }, credits: { has_credits: true, balance: "40" },
  });
  assert.equal(s.providerCost.used, 250);
  assert.equal(s.providerCost.limit, 1000);
  assert.equal(s.providerCost.balance, 40);
  for (const body of [{ rate_limit: { individual_limit: { limit: 1000, remaining_percent: 75 } } },
    { spendControl: { individualLimit: { limit: 1000, remainingPercent: 75 } } }]) {
    const cost = (await fetch("codex", body)).snapshot.providerCost;
    assert.equal(cost.used, 250);
    assert.equal(cost.limit, 1000);
  }
});

test("Codex does not double-count a monthly pool repeated as credit balance", async () => {
  const { snapshot: s } = await fetch("codex", { individual_limit: { limit: 1000, used: 250 }, credits: { has_credits: true, balance: 750 } });
  assert.equal(s.providerCost.balance, null);
  assert.equal(s.providerCost.used, 250);
});

test("Codex malformed credit counters cannot fabricate zero usage and finite large caps do not overflow", async () => {
  for (const limit of [{ limit: 1000, used: "bad" }, { limit: 1000, remaining_percent: true }]) {
    const { snapshot: s } = await fetch("codex", { individual_limit: limit, rate_limit: { primary_window: window(18000) } });
    assert.equal(s.providerCost, null);
    assert.equal(s.primary.usedPercent, 25);
  }
  const { snapshot: s } = await fetch("codex", { individual_limit: { limit: 1e308, remaining_percent: 75 } });
  assert.equal(s.providerCost.used, 2.5e307);
});

test("Codex fetches missing workspace monthly limits with the same account and a bounded optional request", async () => {
  const { snapshot: s, calls } = await fetch("codex2", { plan_type: "team", spend_control: {} }, { accountId: "account/test" }, {
    effective_monthly_limit: { limit: "1000", enforcement_mode: "enforced" }, current_month_usage: "250",
  });
  assert.equal(s.providerCost.used, 250);
  assert.equal(s.providerCost.limit, 1000);
  assert.match(calls[1][0], /accounts\/account%2Ftest\/spend-controls\/current-user\/monthly-usage$/);
  assert.equal(calls[1][1]["ChatGPT-Account-Id"], "account/test");
  assert.deepEqual(calls[1][2], { timeoutMs: 6000, retry: false });
});

test("Codex optional monthly failures and disabled limits preserve quota and purchased credits", async () => {
  const base = { plan_type: "enterprise", spend_control: {}, rate_limit: { primary_window: window(18000, 15) }, credits: { has_credits: true, balance: 40 } };
  for (const response of [new Error("timeout"), { status: 403 }, { status: 429 }, { body: {} },
    { effective_monthly_limit: { limit: 1000, enforcement_mode: "off" }, current_month_usage: 250 },
    { effective_monthly_limit: { limit: 1000 }, current_month_usage: "bad" }]) {
    const { snapshot: s } = await fetch("codex", base, { accountId: "test" }, response);
    assert.equal(s.primary.usedPercent, 15);
    assert.equal(s.providerCost.limit, 0);
    assert.equal(s.providerCost.balance, 40);
  }
});

test("Codex skips monthly lookups without an account, for personal plans or when a cap is supplied", async () => {
  for (const [body, creds] of [[{ plan_type: "team", spend_control: {} }, {}],
    [{ plan_type: "plus", spend_control: {} }, { accountId: "test" }],
    [{ spend_control: { individual_limit: { limit: 1000, used: 200 } } }, { accountId: "test" }]]) {
    assert.equal((await fetch("codex", body, creds)).calls.length, 1);
  }
});
