const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, mkdtempSync, rmSync } = require("node:fs");
const { createRequire } = require("node:module");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const webRequire = createRequire(join(__dirname, "../package.json"));
const ts = webRequire("typescript");
const core = require(join(process.env.QUOTA_TEST_BUILD_DIR, "index.js"));
const requireCoreAuth = () => require(join(process.env.QUOTA_TEST_BUILD_DIR, "providers/grok-auth.js"));

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "quota-settings-"));
  const env = { dbPath: join(directory, "test.sqlite"), encKey: "00".repeat(32), authDisabled: false, dashboardPassword: "test" };
  const modules = new Map();
  let authed = false;
  let networkCalls = 0;
  let safetyCheck = async () => {};
  const http = { get: async () => { networkCalls++; return { status: 500, body: "synthetic failure", headers: {} }; } };
  function load(relative) {
    if (modules.has(relative)) return modules.get(relative);
    const filename = join(__dirname, "..", relative);
    const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
      fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    });
    const module = { exports: {} };
    const require = (name) => {
      if (name === "@quota/core/grok-auth") return requireCoreAuth();
      if (name === "@/lib/ssrf") return { assertSafeBaseUrl: async () => safetyCheck() };
      if (name === "@quota/core") return { ...core, nodeHttpClient: http };
      if (name === "next/headers") return { cookies: async () => ({ get: () => ({ value: authed ? "valid" : "" }) }) };
      if (name === "@/lib/auth" || name === "./lib/auth") return { SESSION_COOKIE: "session", verifySessionToken: async (token) => token === "valid" };
      if (name === "@/lib/env" || name === "./env" || name === "./lib/env") return { ENV: env };
      if (name === "./notify") return { detectAndNotifyResets() {}, detectAndNotifyAlerts() {} };
      if (name.startsWith("@/")) return load(`${name.slice(2)}.ts`);
      if (name.startsWith(".")) return load(join(relative.slice(0, relative.lastIndexOf("/")), `${name}.ts`));
      return webRequire(name);
    };
    new Function("require", "module", "exports", outputText)(require, module, module.exports);
    modules.set(relative, module.exports);
    return module.exports;
  }
  const oldFetcher = globalThis.quotaUsageFetcher;
  delete globalThis.quotaUsageFetcher;
  return {
    load, modules, env, get networkCalls() { return networkCalls; },
    set authed(value) { authed = value; },
    set safetyCheck(value) { safetyCheck = value; },
    close() {
      load("lib/db.ts").db().close();
      if (oldFetcher) globalThis.quotaUsageFetcher = oldFetcher;
      else delete globalThis.quotaUsageFetcher;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("provider switches persist, hide public cards, and prevent scheduled and direct usage requests", async (t) => {
  const f = fixture();
  const store = f.load("lib/store.ts");
  const providers = f.load("app/api/providers/route.ts");
  const usage = f.load("app/api/usage/route.ts");
  const request = (body) => new Request("http://localhost/api/providers", { method: "PATCH", body: JSON.stringify(body) });
  try {
    await t.test("existing providers default to enabled; invalid settings do not mutate storage", async () => {
      const data = await (await providers.GET()).json();
      assert.ok(data.providers.length > 0);
      assert.ok(data.providers.every((p) => p.enabled));
      for (const body of [null, {}, { provider: "unknown", enabled: false }, { provider: "rightapi", enabled: "false" }]) {
        assert.equal((await providers.PATCH(request(body))).status, 400);
      }
      assert.equal((await providers.PATCH(new Request("http://localhost/api/providers", { method: "PATCH", body: "{" }))).status, 400);
      assert.equal(store.listProviderSettings().size, 0);
    });
    await t.test("disable before configuring; credential replacement preserves the switch and history", async () => {
      assert.equal((await providers.PATCH(request({ provider: "rightapi", enabled: false }))).status, 200);
      store.saveCredential("rightapi", "auto", { bearerToken: "synthetic" }, new Date());
      const snapshot = { provider: "rightapi", primary: null, secondary: null, tertiary: null, updatedAt: new Date().toISOString() };
      store.saveSnapshot("rightapi", snapshot, null, new Date());
      assert.equal(store.getCredential("rightapi").enabled, false);
      assert.equal(store.listCredentials().find((p) => p.provider === "rightapi").enabled, false);
      assert.equal(store.historyFor("rightapi").length, 1);
      assert.ok(!(await (await usage.GET()).json()).providers.some((p) => p.provider === "rightapi"));
      f.authed = true;
      assert.ok(!(await (await usage.GET()).json()).providers.some((p) => p.provider === "rightapi"));
      store.saveCredential("rightapi", "auto", { bearerToken: "replacement" }, new Date());
      assert.equal(store.getCredential("rightapi").enabled, false);
      assert.equal(store.getCredential("rightapi").credentials.bearerToken, "replacement");
    });
    await t.test("background/manual batch skips disabled providers; re-enabling restores fetching", async () => {
      const fetcher = f.load("lib/fetcher.ts");
      await fetcher.fetchAllConfigured();
      await fetcher.fetchAndStore("rightapi");
      assert.equal(f.networkCalls, 0);
      await providers.PATCH(request({ provider: "rightapi", enabled: true }));
      assert.ok((await (await usage.GET()).json()).providers.some((p) => p.provider === "rightapi"));
      await fetcher.fetchAllConfigured();
      assert.ok(f.networkCalls > 0);
      const calls = f.networkCalls;
      await providers.PATCH(request({ provider: "rightapi", enabled: false }));
      await fetcher.fetchAllConfigured();
      assert.equal(f.networkCalls, calls);
      assert.equal(store.listSnapshots().length, 1);
    });
    await t.test("a fresh database connection retains the disabled setting", () => {
      f.load("lib/db.ts").db().close();
      f.modules.delete("lib/db.ts");
      f.modules.delete("lib/store.ts");
      const reopened = f.load("lib/store.ts");
      assert.equal(reopened.listProviderSettings().get("rightapi"), false);
      assert.equal(reopened.getCredential("rightapi").enabled, false);
      assert.equal(reopened.getCredential("rightapi").credentials.bearerToken, "replacement");
    });
    await t.test("middleware denies anonymous setting writes and permits authenticated admins", async () => {
      const { NextRequest } = webRequire("next/server");
      const { middleware } = f.load("middleware.ts");
      const make = (method, cookie) => new NextRequest("http://localhost/api/providers", { method, headers: cookie ? { cookie } : {} });
      assert.equal((await middleware(make("PATCH"))).status, 401);
      assert.equal((await middleware(make("PATCH", "session=valid"))).status, 200);
      assert.equal((await middleware(make("GET"))).status, 200);
    });
  } finally { f.close(); }
});

test("credential editing preserves same-account values, requires explicit replacement, and does not expose secrets", async (t) => {
  const f = fixture();
  const store = f.load("lib/store.ts");
  const route = f.load("app/api/credentials/route.ts");
  const request = (body) => new Request("http://localhost/api/credentials", { method: "POST", body: JSON.stringify(body) });
  const now = new Date();
  try {
    store.setProviderEnabled("codex", false);
    store.saveCredential("codex", "oauth", { bearerToken: "old-access", refreshToken: "old-refresh", accountId: "same-account", expiresAt: "2026-11-01T00:00:00Z", refreshState: { blocked: true } }, now);
    store.saveSnapshot("codex", { provider: "codex", primary: null, secondary: null, tertiary: null }, null, now);
    await t.test("admin metadata reports configured keys and fetch status without returning tokens", async () => {
      const res = await route.GET();
      const text = await res.text();
      assert.doesNotMatch(text, /old-access|old-refresh|same-account/);
      const entry = JSON.parse(text).credentials[0];
      assert.ok(entry.configuredKeys.includes("refreshToken"));
      assert.equal(entry.enabled, false);
      assert.equal(entry.fetchedAt, now.toISOString());
      assert.equal(entry.fetchError, null);
    });
    await t.test("blank optional inputs retain existing values; rotated access clears stale expiry and block state", async () => {
      store.saveAlertState("codex", "health", { level: 2, failures: 3, channels: {} });
      store.saveAlertState("codex", "quota-existing", { level: 80, channels: {} });
      const res = await route.POST(request({ provider: "codex", action: "update", fields: { bearerToken: "new-access", refreshToken: "" }, confirmSameAccount: true }));
      assert.equal(res.status, 200);
      assert.equal((await res.json()).disabled, true);
      const credential = store.getCredential("codex");
      assert.equal(credential.credentials.bearerToken, "new-access");
      assert.equal(credential.credentials.refreshToken, "old-refresh");
      assert.equal(credential.credentials.accountId, "same-account");
      assert.equal(credential.credentials.expiresAt, undefined);
      assert.equal(credential.credentials.refreshState, undefined);
      assert.equal(credential.mode, "oauth");
      assert.equal(store.historyFor("codex").length, 1);
      assert.equal(store.listSnapshots().length, 1);
      assert.equal(f.networkCalls, 0);
      assert.equal(store.getAlertState("codex", "health").failures, 0);
      assert.equal(store.getAlertState("codex", "quota-existing").level, 80);
    });
    await t.test("clear optional values explicitly; reject token mixing and invalid fields without writing", async () => {
      const clear = await route.POST(request({ provider: "codex", action: "update", fields: {}, clearFields: ["refreshToken"] }));
      assert.equal(clear.status, 200);
      assert.equal(store.getCredential("codex").credentials.refreshToken, undefined);
      const revision = store.getCredential("codex").revision;
      for (const body of [
        { provider: "codex", action: "update", fields: { bearerToken: "unconfirmed" } },
        { provider: "codex", action: "update", fields: { accountId: "other-account" }, confirmSameAccount: true },
        { provider: "codex", action: "update", clearFields: ["bearerToken"] },
        { provider: "codex", action: "update", fields: { bearerToken: 123 } },
        { provider: "codex", action: "delete" },
        { provider: "codex", fields: [] }, null,
      ]) {
        assert.equal((await route.POST(request(body))).status, 400);
        assert.equal(store.getCredential("codex").revision, revision);
      }
    });
    await t.test("full replacement removes previous optional credentials and account usage", async () => {
      const res = await route.POST(request({ provider: "codex", action: "replace", fields: { bearerToken: "other-access", accountId: "other-account" } }));
      assert.equal(res.status, 200);
      assert.equal(store.getCredential("codex").credentials.refreshToken, undefined);
      assert.equal(store.getCredential("codex").credentials.accountId, "other-account");
      assert.equal(store.historyFor("codex").length, 0);
      assert.equal(store.listSnapshots().length, 0);
      assert.equal(store.getCredential("codex").enabled, false);
    });
    await t.test("concurrent OAuth rotation cannot be overwritten by a partial form update", async () => {
      store.setProviderEnabled("rightapi", false);
      store.saveCredential("rightapi", "api", { bearerToken: "rightapi-access" }, now);
      f.safetyCheck = async () => {
        const current = store.getCredential("rightapi");
        store.updateCredentialSecret("rightapi", { ...current.credentials, bearerToken: "rotated-during-validation" }, now, current.revision);
      };
      const raced = await route.POST(request({ provider: "rightapi", action: "update", fields: { baseUrlOverride: "https://example.com" } }));
      assert.equal(raced.status, 409);
      assert.equal(store.getCredential("rightapi").credentials.bearerToken, "rotated-during-validation");
      assert.equal(store.getCredential("rightapi").credentials.baseUrlOverride, undefined);
    });
    await t.test("targeted refresh rejects unconfigured or disabled channels and refreshes only the selected channel", async () => {
      const refresh = f.load("app/api/refresh/route.ts");
      const call = (body) => refresh.POST(new Request("http://localhost/api/refresh", { method: "POST", body: JSON.stringify(body) }));
      assert.equal((await call({ provider: "grok" })).status, 409);
      assert.equal((await call({ provider: "rightapi" })).status, 409);
      assert.equal((await call({ provider: "unknown" })).status, 400);
      assert.equal(f.networkCalls, 0);
      store.setProviderEnabled("rightapi", true);
      const res = await call({ provider: "rightapi" });
      assert.equal(res.status, 200);
      assert.equal(f.networkCalls, 1);
      assert.equal(store.getCredential("codex").credentials.bearerToken, "other-access");
    });
    await t.test("nested configured fields use their form keys without returning values", async () => {
      store.saveCredential("grok", "oauth", { bearerToken: "grok-secret", extra: { clientId: "private-client-id" } }, now);
      const data = await (await route.GET()).json();
      const grok = data.credentials.find((c) => c.provider === "grok");
      assert.ok(grok.configuredKeys.includes("extra.clientId"));
      assert.ok(!grok.configuredKeys.includes("extra"));
      assert.doesNotMatch(JSON.stringify(data), /grok-secret|private-client-id/);
    });
  } finally { f.close(); }
});

test("imported Codex and Claude credentials save through the existing API without retaining old optional tokens", async () => {
  const f = fixture();
  try {
    const store = f.load("lib/store.ts");
    const route = f.load("app/api/credentials/route.ts");
    const { parseCredentialJson } = f.load("lib/credential-import.ts");
    for (const provider of ["codex", "codex2", "claude"]) {
      store.setProviderEnabled(provider, false);
      store.saveCredential(provider, "auto", { bearerToken: "previous-access", refreshToken: "previous-refresh", accountId: "previous-account" }, new Date());
      const source = provider === "claude"
        ? { claudeAiOauth: { accessToken: "imported-access", refreshToken: "imported-refresh" }, mcpOAuth: { secret: "never-submit" } }
        : { tokens: { access_token: "imported-access", refresh_token: "imported-refresh", account_id: "imported-account", id_token: "never-submit" } };
      const save = (fields) => route.POST(new Request("http://localhost/api/credentials", {
        method: "POST", body: JSON.stringify({ provider, action: "replace", fields }),
      }));
      const fields = parseCredentialJson(provider, JSON.stringify(source));
      assert.doesNotMatch(JSON.stringify(fields), /never-submit/);
      assert.equal((await save(fields)).status, 200);
      assert.deepEqual(store.getCredential(provider).credentials, fields);
      assert.equal((await save(parseCredentialJson(provider, '{"bearerToken":"access-only"}'))).status, 200);
      assert.deepEqual(store.getCredential(provider).credentials, { bearerToken: "access-only" });
    }
    assert.equal(f.networkCalls, 0);
  } finally { f.close(); }
});
