const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, mkdtempSync, rmSync } = require("node:fs");
const { createRequire } = require("node:module");
const { join, dirname } = require("node:path");
const { tmpdir } = require("node:os");
const webRequire = createRequire(join(__dirname, "../package.json"));
const ts = webRequire("typescript");
const core = require(join(process.env.QUOTA_TEST_BUILD_DIR, "index.js"));
const Database = webRequire("better-sqlite3");

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "quota-accounts-"));
  const env = { dbPath: join(directory, "test.sqlite"), encKey: "00".repeat(32), pollInterval: 300, authDisabled: false,
    dashboardPassword: "test", notifyAlertsEnabled: true, feishuWebhookUrl: "https://synthetic.invalid",
    notifyUsageThresholds: [80, 95], notifyBalanceThresholds: {}, notifyFailureThreshold: 3,
    notifyCooldownSeconds: 21600, notifyStaleSeconds: 1800, notifyRecovery: true, notifyMinUsedPercent: 80 };
  const modules = new Map(), calls = [], messages = [];
  let authed = true;
  let safetyCheck = async () => {};
  let upstream = async (_url, headers) => ({ status: 200, headers: {}, body: JSON.stringify({
    rate_limit: { primary_window: { used_percent: headers.Authorization.includes("work") ? 85 : 97, limit_window_seconds: 18000 } },
    credits: { has_credits: true, balance: 42 },
  }) });
  class FakeChannel { name = "feishu"; async send(message) { messages.push(message); } }
  function load(relative) {
    if (modules.has(relative)) return modules.get(relative);
    const filename = join(__dirname, "..", relative);
    const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
      fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    });
    const module = { exports: {} };
    const require = (name) => {
      if (name === "@quota/core") return { ...core, nodeHttpClient: { get: async (...args) => { calls.push(args); return upstream(...args); } } };
      if (name === "@quota/core/grok-auth") return requireCore("providers/grok-auth.js");
      if (name === "next/headers") return { cookies: async () => ({ get: () => ({ value: authed ? "valid" : "" }) }) };
      if (name === "@/lib/auth" || name === "./lib/auth") return { SESSION_COOKIE: "session", verifySessionToken: async (value) => value === "valid" };
      if (["@/lib/env", "./env", "../env", "./lib/env"].includes(name)) return { ENV: env };
      if (name === "./feishu") return { FeishuChannel: FakeChannel };
      if (name === "@/lib/ssrf") return { assertSafeBaseUrl: (...args) => safetyCheck(...args) };
      if (name === "./notify") return load("lib/notify/index.ts");
      if (name.startsWith("@/")) return load(`${name.slice(2)}.ts`);
      if (name.startsWith(".")) return load(join(dirname(relative), `${name}.ts`));
      return webRequire(name);
    };
    new Function("require", "module", "exports", outputText)(require, module, module.exports);
    modules.set(relative, module.exports);
    return module.exports;
  }
  const requireCore = (path) => require(join(process.env.QUOTA_TEST_BUILD_DIR, path));
  const oldFetcher = globalThis.quotaUsageFetcher;
  delete globalThis.quotaUsageFetcher;
  return { load, modules, env, calls, messages, get store() { return load("lib/store.ts"); },
    set authed(value) { authed = value; }, set upstream(value) { upstream = value; },
    set safetyCheck(value) { safetyCheck = value; },
    close() {
      modules.get("lib/db.ts")?.db().close();
      if (oldFetcher) globalThis.quotaUsageFetcher = oldFetcher;
      else delete globalThis.quotaUsageFetcher;
      rmSync(directory, { recursive: true, force: true });
    } };
}

const stamp = new Date("2026-11-06T12:00:00Z");
const sample = (used, provider = "codex") => ({ provider, primary: { usedPercent: used, usageKnown: true, windowMinutes: 300 }, secondary: null, tertiary: null, dataConfidence: "exact", updatedAt: stamp.toISOString() });
const request = (method, body, path = "accounts") => new Request(`http://localhost/api/${path}`, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

test("legacy Codex slots migrate without decrypting or rewriting credentials, history, switches, or notification state", () => {
  const f = fixture();
  try {
    const ciphertext = f.load("lib/crypto.ts").encrypt(JSON.stringify({ bearerToken: "legacy-secret", refreshToken: "legacy-refresh" }));
    const old = new Database(f.env.dbPath);
    old.exec(`CREATE TABLE credentials (provider TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, mode TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE provider_settings (provider TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE snapshots (provider TEXT PRIMARY KEY, snapshot TEXT, error TEXT, fetched_at TEXT NOT NULL);
      CREATE TABLE snapshot_history (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, snapshot TEXT NOT NULL, fetched_at TEXT NOT NULL);
      CREATE TABLE notification_alert_state (provider TEXT NOT NULL, alert_key TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(provider,alert_key));`);
    for (const provider of ["codex", "codex2"]) {
      old.prepare("INSERT INTO credentials VALUES (?,1,'oauth',?,?)").run(provider, ciphertext, stamp.toISOString());
      old.prepare("INSERT INTO snapshots VALUES (?,?,NULL,?)").run(provider, JSON.stringify(sample(provider === "codex" ? 42 : 95, provider)), stamp.toISOString());
      old.prepare("INSERT INTO snapshot_history(provider,snapshot,fetched_at) VALUES (?,?,?)").run(provider, JSON.stringify(sample(50, provider)), stamp.toISOString());
    }
    old.prepare("INSERT INTO provider_settings VALUES ('codex2',0)").run();
    old.prepare("INSERT INTO notification_alert_state VALUES ('codex2','health',?)").run('{"level":2,"channels":{}}');
    old.close();
    const accounts = f.store.listAccounts();
    assert.equal(accounts.length, 2);
    assert.ok(accounts.every((account) => account.provider === "codex"));
    assert.equal(f.store.getAccount("codex2").alias, "Codex #2");
    assert.equal(f.store.getCredential("codex2").enabled, false);
    assert.equal(f.store.getCredential("codex2").provider, "codex");
    assert.equal(f.store.getCredential("codex2").credentials.bearerToken, "legacy-secret");
    assert.equal(f.load("lib/db.ts").db().prepare("SELECT data FROM credentials WHERE provider='codex2'").get().data, ciphertext);
    assert.equal(f.store.historyFor("codex2")[0].snapshot.provider, "codex");
    assert.equal(f.store.listSnapshots().find((row) => row.provider === "codex2").snapshot.primary.usedPercent, 95);
    assert.equal(f.store.getAlertState("codex2", "health").level, 2);
    f.store.updateAccount("codex2", { alias: "个人账号", groupName: "个人", enabled: true });
    f.load("lib/db.ts").db().close();
    f.modules.delete("lib/db.ts"); f.modules.delete("lib/store.ts");
    assert.equal(f.store.listAccounts().length, 2, "migration is idempotent");
    assert.equal(f.store.getAccount("codex2").alias, "个人账号");
    assert.equal(f.store.getCredential("codex2").enabled, true);
    assert.equal(f.store.historyFor("codex2").length, 1);
    f.store.deleteAccount("codex2");
    f.load("lib/db.ts").db().close();
    f.modules.delete("lib/db.ts"); f.modules.delete("lib/store.ts");
    assert.equal(f.store.getAccount("codex2"), null, "deleted legacy accounts do not reappear after restart");
    assert.equal(f.store.getCredential("codex").credentials.bearerToken, "legacy-secret");
  } finally { f.close(); }
});

test("account API adds unrestricted provider instances, validates metadata, and only deletes the targeted account", async () => {
  const f = fixture();
  try {
    const api = f.load("app/api/accounts/route.ts");
    assert.deepEqual((await (await api.GET()).json()).accounts, [], "fresh installs have no fixed slots");
    const created = [];
    for (let i = 0; i < 4; i++) {
      const res = await api.POST(request("POST", { provider: "codex", alias: `账号 ${i}`, groupName: i < 2 ? "工作" : "个人" }));
      assert.equal(res.status, 201);
      created.push((await res.json()).account);
    }
    assert.equal(new Set(created.map((account) => account.id)).size, 4);
    assert.ok(created.every((account) => account.provider === "codex"));
    const [work, personal] = created;
    f.store.saveCredential(work.id, "oauth", { bearerToken: "work-secret" }, stamp);
    f.store.saveCredential(personal.id, "oauth", { bearerToken: "personal-secret" }, stamp);
    f.store.saveSnapshot(work.id, sample(85), null, stamp);
    f.store.saveSnapshot(personal.id, sample(97), null, stamp);
    f.store.saveAlertState(work.id, "health", { level: 2, channels: {} });
    const revision = f.store.getCredential(work.id).revision;
    assert.equal((await api.PATCH(request("PATCH", { accountId: work.id, alias: "工作主账号", groupName: "团队 A" }))).status, 200);
    assert.equal(f.store.getCredential(work.id).revision, revision);
    assert.equal(f.store.historyFor(work.id).length, 1);
    assert.equal(f.store.getAlertState(work.id, "health").level, 2);
    for (const body of [null, {}, { provider: "codex2", alias: "old" }, { provider: "unknown", alias: "x" },
      { provider: "codex", alias: " " }, { provider: "codex", alias: "x".repeat(81) }, { provider: "codex", alias: "x", groupName: [] }, { provider: "codex", alias: "x\n" }]) {
      assert.equal((await api.POST(request("POST", body))).status, 400);
    }
    for (const body of [{ accountId: work.id, provider: "claude" }, { accountId: work.id, enabled: "false" }, { accountId: work.id, alias: "" }]) {
      assert.equal((await api.PATCH(request("PATCH", body))).status, 400);
    }
    assert.equal((await api.PATCH(request("PATCH", { accountId: "missing", alias: "x" }))).status, 404);
    const data = await (await api.GET()).text();
    assert.doesNotMatch(data, /work-secret|personal-secret|bearerToken/);
    assert.equal((await api.DELETE(new Request(`http://localhost/api/accounts?accountId=${work.id}`))).status, 200);
    assert.equal(f.store.getAccount(work.id), null);
    assert.equal(f.store.getCredential(work.id), null);
    assert.equal(f.store.historyFor(work.id).length, 0);
    assert.equal(f.store.getAlertState(work.id, "health"), null);
    assert.equal(f.store.getCredential(personal.id).credentials.bearerToken, "personal-secret");
    assert.equal(f.store.historyFor(personal.id).length, 1);
    assert.equal(core.listDescriptors().filter((item) => item.provider.startsWith("codex")).length, 1);
  } finally { f.close(); }
});

test("credentials, target refresh, polling, dashboard and history stay isolated for the same provider", async () => {
  const f = fixture();
  try {
    const work = f.store.createAccount("codex", "工作", "团队");
    const personal = f.store.createAccount("codex", "个人", "个人");
    const credentials = f.load("app/api/credentials/route.ts");
    for (const [account, token] of [[work, "work-secret"], [personal, "personal-secret"]]) {
      const res = await credentials.POST(request("POST", { accountId: account.id, action: "replace", fields: { bearerToken: token } }, "credentials"));
      assert.equal(res.status, 200);
    }
    assert.equal(f.store.listCredentials().length, 2);
    const usage = f.load("app/api/usage/route.ts");
    const views = (await (await usage.GET()).json()).providers;
    assert.equal(views.length, 2);
    assert.ok(views.every((view) => view.provider === "codex"));
    assert.equal(views.find((view) => view.accountId === work.id).snapshot.primary.usedPercent, 85);
    assert.equal(views.find((view) => view.accountId === personal.id).snapshot.primary.usedPercent, 97);
    assert.match(JSON.stringify(f.messages), /工作/);
    assert.match(JSON.stringify(f.messages), /个人/);
    const count = f.calls.length;
    const refresh = f.load("app/api/refresh/route.ts");
    assert.equal((await refresh.POST(request("POST", { accountId: work.id }, "refresh"))).status, 200);
    assert.equal(f.calls.length, count + 1);
    assert.equal(f.calls.at(-1)[1].Authorization, "Bearer work-secret");
    const history = f.load("app/api/history/route.ts");
    const historic = await (await history.GET(new Request(`http://localhost/api/history?accountId=${personal.id}&range=24h`))).json();
    assert.equal(historic.accountId, personal.id);
    assert.equal(historic.series.find((series) => series.kind === "quota").latest, 97);
    f.authed = false;
    const publicData = await (await usage.GET()).text();
    assert.doesNotMatch(publicData, /work-secret|personal-secret|Credits|identity|accountEmail/);
    const publicHistory = await (await history.GET(new Request(`http://localhost/api/history?accountId=${personal.id}`))).text();
    assert.doesNotMatch(publicHistory, /balance|Credits/);
    f.store.updateAccount(work.id, { enabled: false });
    assert.equal((await (await usage.GET()).json()).providers.length, 1);
    assert.equal((await history.GET(new Request(`http://localhost/api/history?accountId=${work.id}`))).status, 404);
    assert.equal((await refresh.POST(request("POST", { accountId: work.id }, "refresh"))).status, 409);
    const before = f.calls.length;
    await f.load("lib/fetcher.ts").fetchAllConfigured();
    assert.equal(f.calls.length, before + 1);
    assert.equal(f.calls.at(-1)[1].Authorization, "Bearer personal-secret");
    assert.equal(f.store.getCredential(work.id).credentials.bearerToken, "work-secret");
    assert.equal((await credentials.POST(request("POST", { accountId: personal.id, provider: "claude", fields: {} }, "credentials"))).status, 400);
  } finally { await new Promise((resolve) => setImmediate(resolve)); f.close(); }
});

test("account endpoints remain admin-only and retired account IDs cannot modify another account", async () => {
  const f = fixture();
  try {
    const { middleware } = f.load("middleware.ts");
    const { NextRequest } = webRequire("next/server");
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      assert.equal((await middleware(new NextRequest("http://localhost/api/accounts", { method }))).status, 401);
      assert.equal((await middleware(new NextRequest("http://localhost/api/accounts", { method, headers: { cookie: "session=valid" } }))).status, 200);
    }
    const account = f.store.createAccount("codex", "删除测试");
    f.store.deleteAccount(account.id);
    const credentials = f.load("app/api/credentials/route.ts");
    assert.equal((await credentials.POST(request("POST", { accountId: account.id, fields: { bearerToken: "secret" } }, "credentials"))).status, 404);
    assert.equal(f.store.listAccounts().length, 0);
  } finally { f.close(); }
});

test("reset reminders and warning cooldowns do not suppress a second account of the same provider", async () => {
  const f = fixture();
  try {
    const accounts = [f.store.createAccount("codex", "工作", "团队"), f.store.createAccount("codex", "个人", "个人")];
    const notify = f.load("lib/notify/index.ts");
    for (const account of accounts) {
      f.store.saveCredential(account.id, "oauth", { bearerToken: "synthetic" }, stamp);
      const now = new Date();
      f.store.saveSnapshot(account.id, { ...sample(95), updatedAt: now.toISOString() }, null, now);
      notify.detectAndNotifyResets(account.id, { ...sample(2), updatedAt: now.toISOString() }, now);
      notify.detectAndNotifyAlerts(account.id, sample(95), undefined, now);
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.messages.filter((message) => /配额已重置/.test(message.title)).length, 2);
    assert.equal(f.messages.filter((message) => /额度不足/.test(message.title)).length, 2);
    const key = JSON.stringify(["quota", "primary", null, 300]);
    for (const account of accounts) assert.equal(f.store.getAlertState(account.id, key).channels.feishu.sentLevel, 95);
    assert.match(f.messages[0].lines.join("\n"), /工作/);
    assert.match(JSON.stringify(f.messages), /个人/);
  } finally { f.close(); }
});

test("deletion during asynchronous credential validation cannot recreate a removed account", async () => {
  const f = fixture();
  try {
    const account = f.store.createAccount("rightapi", "待删除账号");
    let resume, entered;
    const waiting = new Promise((resolve) => { resume = resolve; });
    const started = new Promise((resolve) => { entered = resolve; });
    f.safetyCheck = async () => { entered(); await waiting; };
    const route = f.load("app/api/credentials/route.ts");
    const pending = route.POST(request("POST", { accountId: account.id, fields: {
      bearerToken: "synthetic", baseUrlOverride: "https://example.com",
    } }, "credentials"));
    await started;
    f.store.deleteAccount(account.id);
    resume();
    assert.equal((await pending).status, 409);
    assert.equal(f.store.getAccount(account.id), null);
    assert.equal(f.store.getCredential(account.id), null);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});
