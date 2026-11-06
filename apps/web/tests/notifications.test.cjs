const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { createWebLoader, webRequire } = require("./helpers/load-web.cjs");
const ts = webRequire("typescript");
const core = require(join(process.env.QUOTA_TEST_BUILD_DIR, "index.js"));

const start = Date.parse("2026-11-06T12:00:00Z");
const defaults = { usageThresholds: [80, 95], failureThreshold: 3, cooldownSeconds: 21600, staleSeconds: 1800, recovery: true };
function snapshot(used = 20, overrides = {}) {
  return { provider: "codex", primary: { usedPercent: used, windowMinutes: 300, usageKnown: true },
    secondary: null, tertiary: null, dataConfidence: "exact", updatedAt: new Date(start).toISOString(), ...overrides };
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "quota-alerts-"));
  const env = { dbPath: join(directory, "test.sqlite"), encKey: "00".repeat(32), pollInterval: 300,
    notifyAlertsEnabled: true, feishuWebhookUrl: "https://synthetic.invalid/webhook", notifyUsageThresholds: [80, 95],
    notifyBalanceThresholds: {}, notifyFailureThreshold: 3, notifyCooldownSeconds: 21600,
    notifyStaleSeconds: 1800, notifyRecovery: true, notifyMinUsedPercent: 80 };
  const delivered = [];
  let deliver = async (message) => { delivered.push(message); };
  let upstream = async () => ({ status: 200, body: '{"rate_limit":{"primary_window":{"used_percent":20,"limit_window_seconds":18000}}}', headers: {} });
  class FakeChannel { name = "feishu"; send(message) { return deliver(message); } }
  const { load, modules } = createWebLoader((name) => {
    if (name === "@quota/core") return { ...core, nodeHttpClient: { get: (...args) => upstream(...args) } };
    if (name === "@/runtime/env") return { ENV: env };
    if (name === "@/server/notify/feishu") return { FeishuChannel: FakeChannel };
  });
  const priorFetcher = globalThis.quotaUsageFetcher;
  delete globalThis.quotaUsageFetcher;
  const store = load("server/storage/index.ts");
  const channels = [new FakeChannel()];
  const send = async (channel, message, current) => { if (!current()) return false; await channel.send(message); return true; };
  return { load, modules, env, store, channels, delivered, send,
    set deliver(value) { deliver = value; }, set upstream(value) { upstream = value; },
    async process(observation, time = start, opts = {}) {
      await load("server/notify/alerts.ts").processProviderAlerts("codex", observation, new Date(time), { ...defaults, ...opts }, channels, send);
    },
    close() {
      load("server/storage/db.ts").db().close();
      if (priorFetcher) globalThis.quotaUsageFetcher = priorFetcher;
      else delete globalThis.quotaUsageFetcher;
      rmSync(directory, { recursive: true, force: true });
    } };
}

test("quota alerts group windows, escalate at 95%, and persist cooldowns across module and database restarts", async () => {
  const f = fixture();
  try {
    const sample = snapshot(80, { secondary: { usedPercent: 82, windowMinutes: 10080, usageKnown: true } });
    await f.process({ snapshot: sample });
    assert.equal(f.delivered.length, 1);
    assert.match(f.delivered[0].lines.join("\n"), /80%/);
    assert.match(f.delivered[0].lines.join("\n"), /82%/);
    await f.process({ snapshot: sample }, start + 300_000);
    assert.equal(f.delivered.length, 1);
    f.load("server/storage/db.ts").db().close();
    f.modules.clear();
    await f.process({ snapshot: sample }, start + 600_000);
    assert.equal(f.delivered.length, 1);
    await f.process({ snapshot: snapshot(95) }, start + 900_000);
    assert.equal(f.delivered.length, 2);
    assert.match(f.delivered[1].lines.join("\n"), /95%/);
    await f.process({ snapshot: snapshot(99) }, start + 1_200_000);
    assert.equal(f.delivered.length, 2);
    await f.process({ snapshot: snapshot(99) }, start + 900_000 + 21600_000);
    assert.equal(f.delivered.length, 3);
  } finally { f.close(); }
});

test("unknown percentages, breakdown shares, and unlimited costs cannot trigger quota warnings", async () => {
  const f = fixture();
  try {
    await f.process({ snapshot: snapshot(100, {
      primary: { usedPercent: 100, usageKnown: false }, dataConfidence: "unknown",
      secondary: { usedPercent: 100 }, extraRateWindows: [{ id: "unknown", title: "unknown", usageKnown: false, window: { usedPercent: 100 } }],
      usageBreakdown: [{ id: "share", title: "share", usedPercent: 100 }], providerCost: { used: 100, limit: 0, currencyCode: "USD" },
    }) });
    assert.equal(f.delivered.length, 0);
    await f.process({ snapshot: snapshot(0, { primary: { usedPercent: NaN, usageKnown: true } }) });
    assert.equal(f.delivered.length, 0);
    await f.process({ snapshot: snapshot(1, { tertiary: { usedPercent: 98, windowMinutes: 10080, sourceKey: "seven_day_sonnet", usageKnown: true } }) });
    await f.process({ snapshot: snapshot(1, { tertiary: { usedPercent: 97, windowMinutes: 10080, sourceKey: "seven_day_opus", usageKnown: true } }) });
    assert.equal(f.delivered.length, 2);
    assert.match(f.delivered[0].lines.join("\n"), /Sonnet/);
    assert.match(f.delivered[1].lines.join("\n"), /Opus/);
  } finally { f.close(); }
});

test("finite period quotas and opt-in balances alert in their original unit, including zero and negative balances", async () => {
  const f = fixture();
  try {
    const sample = snapshot(10, { providerCost: { used: 96, limit: 100, balance: 0, currencyCode: "Credits", period: "Monthly" } });
    await f.process({ snapshot: sample });
    assert.match(f.delivered[0].lines.join("\n"), /96%/);
    assert.doesNotMatch(f.delivered[0].lines.join("\n"), /余额/);
    await f.process({ snapshot: sample }, start + 300_000, { balanceThreshold: 100 });
    assert.match(f.delivered[1].lines.join("\n"), /余额 0 Credits/);
    const { processProviderAlerts } = f.load("server/notify/alerts.ts");
    for (const [provider, text, expected] of [["moonshot", "Balance: ¥-2.50", /余额 -2.5 ¥/], ["rightapi", "Balance: $0.00 · 待入账 $1.00", /余额 0 \$/]]) {
      await processProviderAlerts(provider, { snapshot: snapshot(0, { provider, primary: null, identity: { loginMethod: text } }) },
        new Date(start), { ...defaults, balanceThreshold: 5 }, f.channels, f.send);
      assert.match(f.delivered.at(-1).lines.join("\n"), expected);
    }
    await f.process({ snapshot: snapshot(0, { providerCost: { used: 0, limit: 0, currencyCode: "Credits" } }) }, start + 600_000, { balanceThreshold: 100 });
    assert.equal(f.delivered.length, 4, "unknown balance is not a zero balance");
  } finally { f.close(); }
});

test("consecutive failures trigger once, credential rejection escalates immediately, and successful fetch recovers once", async () => {
  const f = fixture();
  try {
    await f.process({ snapshot: snapshot() });
    for (let i = 1; i <= 2; i++) await f.process({ issue: { kind: "upstream" } }, start + i * 300_000);
    assert.equal(f.delivered.length, 0);
    await f.process({ issue: { kind: "rate_limit" } }, start + 900_000);
    assert.equal(f.delivered.length, 1);
    assert.match(f.delivered[0].lines.join("\n"), /连续 3 次.*上游限流/);
    await f.process({ issue: { kind: "refresh_rejected" } }, start + 1_200_000);
    assert.equal(f.delivered.length, 2);
    assert.match(f.delivered[1].lines.join("\n"), /永久拒绝.*重新登录/);
    await f.process({ issue: { kind: "refresh_rejected" } }, start + 1_500_000);
    assert.equal(f.delivered.length, 2);
    await f.process({ snapshot: snapshot() }, start + 1_800_000);
    assert.equal(f.delivered.length, 3);
    assert.match(f.delivered[2].title, /恢复/);
    await f.process({ snapshot: snapshot() }, start + 2_100_000);
    assert.equal(f.delivered.length, 3);
    assert.equal(f.store.getAlertState("codex", "health").failures, 0);
    await f.process({ issue: { kind: "credentials" } }, start + 2_400_000);
    assert.equal(f.delivered.length, 4, "a new credential incident after recovery alerts immediately");
  } finally { f.close(); }
});

test("an isolated error has no recovery notification; recovery can be disabled", async () => {
  const f = fixture();
  try {
    await f.process({ issue: { kind: "upstream" } });
    await f.process({ snapshot: snapshot() }, start + 300_000);
    assert.equal(f.delivered.length, 0);
    await f.process({ issue: { kind: "credentials" } }, start + 600_000);
    assert.equal(f.delivered.length, 1);
    await f.process({ snapshot: snapshot() }, start + 900_000, { recovery: false });
    await f.process({ snapshot: snapshot() }, start + 1_200_000);
    assert.equal(f.delivered.length, 1);
  } finally { f.close(); }
});

test("same-account manual credential updates re-arm health warnings, retain quota cooldowns, and allow recovery", async () => {
  const f = fixture();
  try {
    await f.process({ issue: { kind: "credentials" } });
    f.load("server/notify/alerts.ts").resetHealthAlertState("codex");
    assert.equal(f.store.getAlertState("codex", "health").failures, 0);
    await f.process({ snapshot: snapshot(85) }, start + 300_000);
    assert.equal(f.delivered.length, 2);
    assert.match(f.delivered[1].lines.join("\n"), /恢复正常/);
    f.load("server/notify/alerts.ts").resetHealthAlertState("codex");
    await f.process({ issue: { kind: "credentials" } }, start + 600_000);
    assert.equal(f.delivered.length, 3);
    await f.process({ snapshot: snapshot(85) }, start + 900_000);
    assert.equal(f.delivered.length, 4);
    assert.doesNotMatch(f.delivered[3].lines.join("\n"), /85%/, "manual token edits do not reset quota cooldowns");
  } finally { f.close(); }
});

test("failed deliveries retry next observation, while concurrent processors reserve only one message", async () => {
  const f = fixture();
  try {
    f.deliver = async () => { throw new Error("synthetic notification outage"); };
    await f.process({ snapshot: snapshot(85) });
    const state = f.store.getAlertState("codex", JSON.stringify(["quota", "primary", null, 300]));
    assert.equal(state.channels.feishu.sentAt, undefined);
    const gate = deferred(), entered = deferred();
    f.deliver = async (message) => { f.delivered.push(message); entered.resolve(); await gate.promise; };
    const first = f.process({ snapshot: snapshot(85) }, start + 300_000);
    await entered.promise;
    await f.process({ snapshot: snapshot(85) }, start + 300_000);
    assert.equal(f.delivered.length, 1);
    gate.resolve();
    await first;
    await f.process({ snapshot: snapshot(85) }, start + 600_000);
    assert.equal(f.delivered.length, 1);
  } finally { f.close(); }
});

test("replacing credentials, deleting credentials, and disabling providers clear alert state without stale acknowledgements", async () => {
  const f = fixture();
  try {
    f.store.saveCredential("codex", "auto", { bearerToken: "synthetic" }, new Date(start));
    const gate = deferred(), entered = deferred();
    f.deliver = async () => { entered.resolve(); await gate.promise; };
    const pending = f.process({ issue: { kind: "credentials" } });
    await entered.promise;
    f.store.saveCredential("codex", "auto", { bearerToken: "replacement" }, new Date(start + 60_000));
    gate.resolve();
    await pending;
    assert.equal(f.store.getAlertState("codex", "health"), null);
    f.deliver = async (message) => { f.delivered.push(message); };
    await f.process({ issue: { kind: "credentials" } }, start + 120_000);
    f.store.setProviderEnabled("codex", false);
    assert.equal(f.store.getAlertState("codex", "health"), null);
    f.store.setProviderEnabled("codex", true);
    await f.process({ issue: { kind: "credentials" } }, start + 180_000);
    f.store.deleteCredential("codex");
    assert.equal(f.store.getAlertState("codex", "health"), null);
  } finally { f.close(); }
});

test("stale warnings respect age, do not duplicate active failures, retry delivery, and recover on success", async () => {
  const f = fixture();
  try {
    const observation = { staleSince: new Date(start).toISOString() };
    await f.process(observation, start + 1_799_000);
    assert.equal(f.delivered.length, 0);
    await f.process(observation, start + 1_800_000);
    assert.equal(f.delivered.length, 1);
    assert.match(f.delivered[0].lines.join("\n"), /长时间未更新/);
    await f.process(observation, start + 2_100_000);
    assert.equal(f.delivered.length, 1);
    await f.process({ snapshot: snapshot() }, start + 2_400_000);
    assert.equal(f.delivered.length, 2);
    await f.process({ issue: { kind: "credentials" } }, start + 3_000_000);
    const count = f.delivered.length;
    await f.process(observation, start + 3_300_000);
    assert.equal(f.delivered.length, count);
  } finally { f.close(); }
});

test("production fetcher integrates alerts without forwarding raw upstream errors or exposing secrets", async () => {
  const f = fixture();
  try {
    f.store.saveCredential("codex", "auto", { bearerToken: "secret-access-token" }, new Date());
    f.upstream = async () => ({ status: 401, body: 'secret-upstream-content', headers: {} });
    const { fetchAndStore } = f.load("server/usage/fetcher.ts");
    await fetchAndStore("codex");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.delivered.length, 1);
    assert.match(f.delivered[0].title, /凭据/);
    assert.doesNotMatch(JSON.stringify(f.delivered), /secret-|bearerToken|accountEmail/);
    await fetchAndStore("codex");
    assert.equal(f.delivered.length, 1);
    f.upstream = async () => ({ status: 200, body: '{"rate_limit":{"primary_window":{"used_percent":85,"limit_window_seconds":18000}}}', headers: {} });
    await fetchAndStore("codex");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.delivered.length, 2);
    assert.match(f.delivered[1].lines.join("\n"), /恢复正常/);
    assert.match(f.delivered[1].lines.join("\n"), /85%/);
    f.env.notifyAlertsEnabled = false;
    f.upstream = async () => ({ status: 401, body: "", headers: {} });
    await fetchAndStore("codex");
    assert.equal(f.delivered.length, 2);
    f.env.notifyAlertsEnabled = true;
    f.store.setProviderEnabled("codex", false);
    await fetchAndStore("codex");
    assert.equal(f.delivered.length, 2);
  } finally { f.close(); }
});

test("alert messages strip raw identity, escape upstream labels, and only include safe dashboard links", () => {
  const f = fixture();
  try {
    const { buildAlertMessage } = f.load("server/notify/message.ts");
    const notices = [{ kind: "quota", title: '<at id="all">**bad**</at>\nlabel', value: 85, threshold: 80 }];
    const message = buildAlertMessage("codex", notices, new Date(start), "https://dashboard.example/path?token=secret#secret");
    assert.doesNotMatch(JSON.stringify(message), /<at|token=|#secret/);
    assert.match(message.lines.join("\n"), /https:\/\/dashboard.example\/path/);
    for (const url of ["javascript:alert(1)", "https://user:secret@example.com", "invalid"]) {
      assert.doesNotMatch(buildAlertMessage("codex", notices, new Date(start), url).lines.join("\n"), /打开看板/);
    }
  } finally { f.close(); }
});

test("an interrupted send lease expires; channel delivery failures never duplicate a successful channel", async () => {
  const f = fixture();
  try {
    const { processProviderAlerts } = f.load("server/notify/alerts.ts");
    const key = JSON.stringify(["quota", "primary", null, 300]);
    f.store.saveAlertState("codex", key, { level: 80, channels: { feishu: { lease: { token: "abandoned", until: start + 60_000 } } } });
    await f.process({ snapshot: snapshot(85) });
    assert.equal(f.delivered.length, 0);
    await f.process({ snapshot: snapshot(85) }, start + 60_000);
    assert.equal(f.delivered.length, 1);
    const calls = { good: 0, bad: 0 };
    const channels = [{ name: "good" }, { name: "bad" }];
    let failing = true;
    const send = async (channel) => {
      calls[channel.name]++;
      return channel.name !== "bad" || !failing;
    };
    await processProviderAlerts("codex", { snapshot: snapshot(85) }, new Date(start + 120_000), defaults, channels, send);
    assert.deepEqual(calls, { good: 1, bad: 1 });
    failing = false;
    await processProviderAlerts("codex", { snapshot: snapshot(85) }, new Date(start + 180_000), defaults, channels, send);
    assert.deepEqual(calls, { good: 1, bad: 2 });
  } finally { f.close(); }
});

test("stale watchdog uses successful history, skips disabled channels, and does not notify without a webhook", async () => {
  const f = fixture();
  try {
    const notify = f.load("server/notify/index.ts");
    f.store.saveCredential("codex", "auto", { bearerToken: "synthetic" }, new Date(start));
    f.store.saveSnapshot("codex", snapshot(20), null, new Date(start));
    notify.checkAndNotifyStaleUsage(new Date(start + 1_799_000));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.delivered.length, 0);
    notify.checkAndNotifyStaleUsage(new Date(start + 1_800_000));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.delivered.length, 1);
    f.store.setProviderEnabled("codex", false);
    notify.checkAndNotifyStaleUsage(new Date(start + 86_400_000));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.delivered.length, 1);
    f.store.setProviderEnabled("codex", true);
    f.env.feishuWebhookUrl = "";
    f.modules.delete("server/notify/index.ts");
    f.load("server/notify/index.ts").checkAndNotifyStaleUsage(new Date(start + 86_400_000));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.delivered.length, 1);
    assert.equal(f.store.getAlertState("codex", "health"), null);
  } finally { f.close(); }
});

test("notification environment settings validate malformed thresholds and clamp numeric limits", () => {
  const filename = join(__dirname, "../runtime/env.ts");
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const parse = (env) => {
    const module = { exports: {} };
    new Function("module", "exports", "process", "console", outputText)(module, module.exports, { env }, { warn() {} });
    return module.exports.ENV;
  };
  const config = parse({ NOTIFY_USAGE_THRESHOLDS: "95,80,95", NOTIFY_FAILURE_THRESHOLD: "0", NOTIFY_COOLDOWN_SECONDS: "-1",
    NOTIFY_STALE_SECONDS: "n/a", NOTIFY_BALANCE_THRESHOLDS: '{"codex":100,"moonshot":5}', NOTIFY_RECOVERY: "false" });
  assert.deepEqual(config.notifyUsageThresholds, [80, 95]);
  assert.deepEqual(config.notifyBalanceThresholds, { codex: 100, moonshot: 5 });
  assert.equal(config.notifyFailureThreshold, 1);
  assert.equal(config.notifyCooldownSeconds, 60);
  assert.equal(config.notifyStaleSeconds, 1800);
  assert.equal(config.notifyRecovery, false);
  assert.deepEqual(parse({ NOTIFY_USAGE_THRESHOLDS: "" }).notifyUsageThresholds, []);
  for (const raw of ["80,", "abc", "0", "101", "Infinity"]) assert.deepEqual(parse({ NOTIFY_USAGE_THRESHOLDS: raw }).notifyUsageThresholds, [80, 95]);
  for (const raw of ['{"invalid":5}', '{"codex":-1}', '{"codex":"5"}', "[]", "null", "{"]) {
    assert.deepEqual(parse({ NOTIFY_BALANCE_THRESHOLDS: raw }).notifyBalanceThresholds, {});
  }
});

test("Feishu renders warning cards in orange and recovery cards in green without real network calls", async () => {
  const f = fixture();
  const previousFetch = globalThis.fetch;
  const requests = [];
  try {
    globalThis.fetch = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response('{"code":0}', { status: 200 });
    };
    const { FeishuChannel } = f.load("server/notify/feishu.ts");
    const { buildAlertMessage } = f.load("server/notify/message.ts");
    const channel = new FeishuChannel("https://synthetic.invalid/webhook");
    await channel.send(buildAlertMessage("codex", [{ kind: "credentials", refreshRejected: true }], new Date(start)));
    await channel.send(buildAlertMessage("codex", [{ kind: "recovery" }], new Date(start)));
    assert.equal(requests[0].card.header.template, "orange");
    assert.equal(requests[1].card.header.template, "green");
    assert.match(requests[0].card.elements[0].text.content, /重新登录/);
  } finally { globalThis.fetch = previousFetch; f.close(); }
});
