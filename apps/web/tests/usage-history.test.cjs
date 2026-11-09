const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { createWebLoader, webRequire } = require("./helpers/load-web.cjs");
const core = require(join(process.env.QUOTA_TEST_BUILD_DIR, "index.js"));

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "quota-history-"));
  const env = { dbPath: join(directory, "test.sqlite"), encKey: "00".repeat(32), authDisabled: false, pollInterval: 300 };
  let authed = false;
  const { load, modules } = createWebLoader((name) => {
    if (name === "@quota/core") return core;
    if (name === "next/headers") return { cookies: async () => ({ get: () => ({ value: authed ? "valid" : "" }) }) };
    if (name === "@/runtime/auth") return { SESSION_COOKIE: "session", verifySessionToken: async (token) => token === "valid" };
    if (name === "@/runtime/env") return { ENV: env };
  });
  return { load, set authed(value) { authed = value; }, close() {
    modules.get("server/storage/db.ts")?.db().close();
    rmSync(directory, { recursive: true, force: true });
  } };
}

const now = Date.parse("2026-11-05T12:00:00Z");
const options = { range: "24h", now, pollIntervalSeconds: 300, includeCosts: false };
function entry(time, used, overrides = {}) {
  return { fetchedAt: new Date(time).toISOString(), snapshot: {
    provider: "codex", primary: { usedPercent: used, windowMinutes: 300, usageKnown: true },
    secondary: null, tertiary: null, dataConfidence: "exact", updatedAt: new Date(time).toISOString(), ...overrides,
  } };
}

test("history leaves unknown values and collection gaps blank, never treating placeholders as zero", () => {
  const f = fixture();
  try {
    const { buildUsageHistory } = f.load("shared/usage-history.ts");
    const data = buildUsageHistory("codex", [
      entry(now - 40 * 60_000, 60),
      entry(now - 35 * 60_000, 0, { primary: { usedPercent: 0, usageKnown: false } }),
      entry(now - 30 * 60_000, 65),
      entry(now, 70),
    ], options);
    const primary = data.series[0];
    assert.equal(data.sampleCount, 4);
    assert.equal(primary.samples, 3);
    assert.equal(primary.min, 60);
    assert.ok(primary.points.filter((point) => point.value === null).length >= 2);
    assert.ok(primary.points.every((point) => !point.reset));
    const unknown = buildUsageHistory("codex", [entry(now, 0, { dataConfidence: "unknown", primary: { usedPercent: 0 } })], options);
    assert.deepEqual(unknown.series, []);
  } finally { f.close(); }
});

test("history marks resets without joining different window durations or model identities", () => {
  const f = fixture();
  try {
    const { buildUsageHistory } = f.load("shared/usage-history.ts");
    const entries = [entry(now - 600_000, 95), entry(now - 300_000, 4),
      entry(now, 2, { primary: { usedPercent: 2, usageKnown: true, windowMinutes: 10080 } })];
    const data = buildUsageHistory("codex", entries, options);
    assert.equal(data.series.length, 2);
    assert.equal(data.series[0].points.filter((point) => point.reset).length, 1);
    assert.equal(data.series[1].points.filter((point) => point.reset).length, 0);
    const models = buildUsageHistory("codex", [
      entry(now - 600_000, 30, { tertiary: { usedPercent: 90, windowMinutes: 10080, sourceKey: "seven_day_sonnet" } }),
      entry(now - 300_000, 40, { tertiary: { usedPercent: 2, windowMinutes: 10080, sourceKey: "seven_day_opus" } }),
    ], options);
    assert.equal(models.series.length, 3);
    assert.ok(models.series.some((series) => series.title === "Sonnet (7d)"));
    assert.ok(models.series.every((series) => series.points.every((point) => !point.reset)));
  } finally { f.close(); }
});

test("long ranges have bounded chart payloads while retaining short-lived usage peaks", () => {
  const f = fixture();
  try {
    const { buildUsageHistory } = f.load("shared/usage-history.ts");
    const entries = Array.from({ length: 20_000 }, (_, i) => entry(now - 86_400_000 + i * 4000, i === 10_001 ? 99 : 25));
    const data = buildUsageHistory("codex", entries, options);
    const series = data.series[0];
    assert.equal(series.samples, entries.length);
    assert.equal(series.max, 99);
    assert.ok(series.points.some((point) => point.value === 99));
    assert.ok(series.points.length <= 360 * 6);
    assert.ok(series.points.every((point, i, all) => !i || point.time > all[i - 1].time));
  } finally { f.close(); }
});

test("sampling cannot reconnect multiple unknown intervals in the same bucket", () => {
  const f = fixture();
  try {
    const { buildUsageHistory } = f.load("shared/usage-history.ts");
    const base = now - 120_000;
    const values = [10, null, 20, null, 90, null, 30];
    const data = buildUsageHistory("codex", values.map((value, i) => entry(base + i * 1000, value ?? 0, {
      primary: { usedPercent: value ?? 0, windowMinutes: 300, usageKnown: value != null },
    })), options);
    const points = data.series[0].points;
    for (let i = 1; i < points.length; i++) {
      assert.ok(points[i].value == null || points[i - 1].value == null);
    }
    assert.equal(data.series[0].max, 90);
  } finally { f.close(); }
});

test("legacy Moonshot and RightAPI balances retain their display unit and stay admin-only", () => {
  const f = fixture();
  try {
    const { buildUsageHistory } = f.load("shared/usage-history.ts");
    for (const [provider, label, value, unit] of [
      ["moonshot", "Balance: ¥42.50", 42.5, "¥"], ["rightapi", "Balance: $-3.25 · 待入账 $1.00", -3.25, "$"],
    ]) {
      const sample = entry(now, 0, { provider, primary: null, identity: { loginMethod: label } });
      const data = buildUsageHistory(provider, [sample], { ...options, includeCosts: true });
      assert.equal(data.series[0].latest, value);
      assert.equal(data.series[0].unit, unit);
      assert.deepEqual(buildUsageHistory(provider, [sample], options).series, []);
    }
  } finally { f.close(); }
});

test("history API enforces range bounds, public privacy, admin costs, and disabled providers", async () => {
  const f = fixture();
  try {
    const store = f.load("server/storage/index.ts");
    const route = f.load("app/api/history/route.ts");
    const stamp = Date.now() - 60_000;
    const sample = entry(stamp, 42, {
      identity: { accountEmail: "private@example.test", loginMethod: "secret-credit-balance" },
      extra: { bearerToken: "secret-token", accountId: "secret-account" },
      providerCost: { used: 25, limit: 100, balance: 73, currencyCode: "Credits", period: "Monthly" },
    });
    store.saveSnapshot("codex", sample.snapshot, null, new Date(stamp));
    const request = (query) => new Request(`http://localhost/api/history?${query}`);
    const publicResponse = await route.GET(request("provider=codex&range=24h"));
    assert.equal(publicResponse.status, 200);
    assert.equal(publicResponse.headers.get("cache-control"), "private, no-store");
    const publicText = await publicResponse.text();
    assert.doesNotMatch(publicText, /private@example|secret-|balance|Monthly|Credits|identity|extra/);
    assert.equal(JSON.parse(publicText).series.length, 1);
    f.authed = true;
    const adminText = await (await route.GET(request("provider=codex&range=7d"))).text();
    assert.doesNotMatch(adminText, /private@example|secret-|identity|bearerToken/);
    const adminData = JSON.parse(adminText);
    assert.equal(adminData.series.find((series) => series.kind === "balance").latest, 73);
    assert.equal(adminData.series.find((series) => series.kind === "spend").latest, 25);
    for (const query of ["", "provider=invalid", "provider=codex&range=365d", "provider=codex&range=__proto__"]) {
      assert.equal((await route.GET(request(query))).status, 400);
    }
    store.setProviderEnabled("codex", false);
    assert.equal((await route.GET(request("provider=codex"))).status, 404);
    const { middleware } = f.load("middleware.ts");
    const { NextRequest } = webRequire("next/server");
    assert.equal((await middleware(new NextRequest("http://localhost/api/history?provider=codex"))).status, 200);
    assert.equal((await middleware(new NextRequest("http://localhost/api/history", { method: "POST" }))).status, 503);
  } finally { f.close(); }
});

test("indexed history query uses timestamp order, includes boundaries, and separates providers", () => {
  const f = fixture();
  try {
    const store = f.load("server/storage/index.ts");
    const samples = [entry(now - 60_000, 30), entry(now - 180_000, 10), entry(now - 120_000, 20)];
    for (const sample of samples) store.saveSnapshot("codex", sample.snapshot, null, new Date(sample.fetchedAt));
    store.saveSnapshot("kimi", { ...samples[0].snapshot, provider: "kimi" }, null, new Date(samples[0].fetchedAt));
    const results = [...store.historyInRange("codex", new Date(now - 180_000), new Date(now - 60_000))];
    assert.deepEqual(results.map((sample) => sample.snapshot.primary.usedPercent), [10, 20, 30]);
    const { buildUsageHistory } = f.load("shared/usage-history.ts");
    const outOfRange = buildUsageHistory("codex", [entry(now - 86_400_001, 50), entry(now + 1, 80)], options);
    assert.equal(outOfRange.sampleCount, 0);
    assert.deepEqual(outOfRange.series, []);
  } finally { f.close(); }
});
