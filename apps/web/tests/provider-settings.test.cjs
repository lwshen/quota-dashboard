const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, mkdtempSync, rmSync } = require("node:fs");
const { createRequire } = require("node:module");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const webRequire = createRequire(join(__dirname, "../package.json"));
const ts = webRequire("typescript");
const core = require(join(process.env.QUOTA_TEST_BUILD_DIR, "index.js"));

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "quota-settings-"));
  const env = { dbPath: join(directory, "test.sqlite"), encKey: "00".repeat(32), authDisabled: false, dashboardPassword: "test" };
  const modules = new Map();
  let authed = false;
  let networkCalls = 0;
  const http = { get: async () => { networkCalls++; return { status: 500, body: "synthetic failure", headers: {} }; } };
  function load(relative) {
    if (modules.has(relative)) return modules.get(relative);
    const filename = join(__dirname, "..", relative);
    const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
      fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    });
    const module = { exports: {} };
    const require = (name) => {
      if (name === "@quota/core") return { ...core, nodeHttpClient: http };
      if (name === "next/headers") return { cookies: async () => ({ get: () => ({ value: authed ? "valid" : "" }) }) };
      if (name === "@/lib/auth" || name === "./lib/auth") return { SESSION_COOKIE: "session", verifySessionToken: async (token) => token === "valid" };
      if (name === "@/lib/env" || name === "./env" || name === "./lib/env") return { ENV: env };
      if (name === "./notify") return { detectAndNotifyResets() {} };
      if (name.startsWith("@/")) return load(`${name.slice(2)}.ts`);
      if (name.startsWith("./")) return load(join(relative.slice(0, relative.lastIndexOf("/")), `${name.slice(2)}.ts`));
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
