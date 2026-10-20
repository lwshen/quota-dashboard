const { test } = require("node:test");
const assert = require("node:assert/strict");
const { join } = require("node:path");
const core = require(join(process.env.QUOTA_TEST_BUILD_DIR, "index.js"));

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function fixture(options = {}) {
  let clock = new Date("2026-10-19T18:00:00Z");
  let serial = 0;
  let record = { enabled: true, mode: "oauth", revision: "original", credentials: { bearerToken: "old-access", refreshToken: "old-refresh", expiresAt: new Date(clock.getTime() + 300000).toISOString() } };
  const writes = [], publications = [], events = [];
  const calls = { usage: 0, refresh: 0 };
  const descriptor = {
    provider: "grok", label: "test", credentialFields: [], producesRateWindows: true, refreshLeadTimeMs: 600000,
    resolveStrategies: () => [{ id: "test", sourceMode: "oauth", isAvailable: () => true, shouldFallback: () => false,
      fetch: async (creds, ctx) => {
        calls.usage++;
        events.push(`usage:${creds.bearerToken}`);
        if (options.usage) return options.usage(creds, ctx);
        return { provider: "grok", primary: null, secondary: null, tertiary: null, dataConfidence: "unknown", updatedAt: ctx.now.toISOString() };
      } }],
    refresh: async (creds, ctx) => {
      calls.refresh++;
      events.push("refresh");
      if (options.refresh) return options.refresh(creds, ctx);
      return { credentials: { ...creds, bearerToken: "new-access", refreshToken: "new-refresh", expiresAt: new Date(ctx.now.getTime() + 21600000).toISOString() } };
    },
  };
  const dependencies = {
    load: () => record,
    update: (_provider, creds, _now, revision) => {
      if (record?.revision !== revision) return null;
      record = { ...record, credentials: creds, revision: String(++serial) };
      writes.push(creds);
      events.push("persist");
      return record.revision;
    },
    publish: (...args) => { publications.push(args); },
    http: () => ({}), descriptor: () => descriptor, now: () => clock,
  };
  const fetch = core.createUsageFetcher(dependencies);
  return { fetch, dependencies, descriptor, calls, writes, publications, events, get record() { return record; },
    replace: (replacement) => { record = replacement; }, advance: (ms) => { clock = new Date(clock.getTime() + ms); } };
}

test("near-expiry credentials are rotated and persisted before usage; concurrent requests share the rotation", async () => {
  const gate = deferred();
  const f = fixture({ refresh: async (creds, ctx) => { await gate.promise; return { credentials: { ...creds, bearerToken: "new-access", refreshToken: "new-refresh", expiresAt: new Date(ctx.now.getTime() + 21600000).toISOString() } }; } });
  const first = f.fetch("grok"), second = f.fetch("grok");
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(f.calls.refresh, 1);
  gate.resolve();
  assert.equal((await first).error, null);
  assert.deepEqual(f.events, ["refresh", "persist", "usage:new-access"]);
  assert.equal(f.record.credentials.refreshToken, "new-refresh");
  assert.equal(f.publications.length, 1);
  await f.fetch("grok");
  assert.equal(f.calls.refresh, 1);
});

test("requests arriving after persistence still join the active fetch", async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture({ usage: async () => { entered.resolve(); return gate.promise; } });
  const first = f.fetch("grok");
  await entered.promise;
  const second = f.fetch("grok");
  assert.equal(first, second);
  gate.resolve({ provider: "grok" });
  await first;
  assert.equal(f.calls.refresh, 1);
});

test("unexpected 401 refreshes once, retries usage, and cannot loop", async () => {
  const f = fixture({ usage: async (creds) => { if (creds.bearerToken === "old-access") throw new core.UnauthorizedError(); return { provider: "grok" }; } });
  f.record.credentials.expiresAt = "2026-10-20T00:00:00Z";
  assert.equal((await f.fetch("grok")).error, null);
  assert.equal(f.calls.refresh, 1);
  assert.equal(f.calls.usage, 2);
  const rejected = fixture({ usage: async () => { throw new core.UnauthorizedError("rejected"); } });
  assert.equal((await rejected.fetch("grok")).error, "rejected");
  assert.equal(rejected.calls.refresh, 1);
  assert.equal(rejected.calls.usage, 1);
});

test("providers without proactive refresh preserve reactive renewal", async () => {
  const f = fixture({ usage: async (creds) => { if (creds.bearerToken === "old-access") throw new core.UnauthorizedError(); return { provider: "codex" }; } });
  delete f.descriptor.refreshLeadTimeMs;
  assert.equal((await f.fetch("codex")).error, null);
  assert.equal(f.calls.usage, 2);
  assert.equal(f.calls.refresh, 1);
});

test("access-token-only credentials never attempt renewal", async () => {
  const f = fixture({ usage: async () => { throw new core.UnauthorizedError("re-login"); } });
  delete f.record.credentials.refreshToken;
  assert.equal((await f.fetch("grok")).error, "re-login");
  assert.equal(f.calls.refresh, 0);
});

test("terminal renewal failure is durable across coordinator restarts and resets on credential replacement", async () => {
  const f = fixture({ refresh: async () => { throw new core.RefreshRejectedError("re-login"); } });
  assert.equal((await f.fetch("grok")).error, "re-login");
  assert.equal(f.record.credentials.refreshState.blocked, true);
  f.advance(86400000);
  const restarted = core.createUsageFetcher(f.dependencies);
  assert.equal((await restarted("grok")).error, "re-login");
  assert.equal(f.calls.refresh, 1);
  f.replace({ ...f.record, revision: "replacement", credentials: { bearerToken: "new-login" } });
  assert.equal((await restarted("grok")).error, null);
});

test("temporary renewal failures retain valid usage and honor durable Retry-After cooldowns", async () => {
  const f = fixture({ refresh: async () => { throw new core.RateLimitedError(900, "retry later"); } });
  assert.equal((await f.fetch("grok")).error, null);
  assert.equal(f.record.credentials.refreshState.retryAt, "2026-10-19T18:15:00.000Z");
  assert.equal((await f.fetch("grok")).error, null);
  assert.equal(f.calls.refresh, 1);
  f.advance(300000);
  f.descriptor.resolveStrategies = () => [{ id: "expired", sourceMode: "oauth", isAvailable: () => true, shouldFallback: () => false, fetch: async () => { throw new core.UnauthorizedError(); } }];
  assert.equal((await f.fetch("grok")).error, "retry later");
  assert.equal(f.calls.refresh, 1);
  f.advance(600000);
  await f.fetch("grok");
  assert.equal(f.calls.refresh, 2);
});

test("expired tokens do not attempt usage when proactive renewal fails", async () => {
  const f = fixture({ refresh: async () => { throw new core.UpstreamError(500, "outage"); } });
  f.advance(600000);
  assert.match((await f.fetch("grok")).error, /outage/);
  assert.equal(f.calls.usage, 0);
});

test("permission failures on otherwise valid credentials do not consume a refresh token", async () => {
  const f = fixture({ usage: async () => { throw new core.UpstreamError(403, "denied"); } });
  f.record.credentials.expiresAt = "2026-10-20T00:00:00Z";
  assert.match((await f.fetch("grok")).error, /denied/);
  assert.equal(f.calls.refresh, 0);
});

test("replacement during a renewal cannot be overwritten or inherit the old result", async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture({ refresh: async (creds) => { entered.resolve(); await gate.promise; return { credentials: { ...creds, bearerToken: "old-account-rotation" } }; } });
  const old = f.fetch("grok");
  await entered.promise;
  f.replace({ ...f.record, revision: "new-account", credentials: { bearerToken: "new-account" } });
  assert.equal((await f.fetch("grok")).error, null);
  gate.resolve();
  assert.match((await old).error, /凭据已变更/);
  assert.equal(f.record.credentials.bearerToken, "new-account");
  assert.equal(f.writes.length, 0);
  assert.equal(f.publications.length, 1);
});

test("deletion during usage does not resurrect a snapshot or notifications", async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture({ usage: async () => { entered.resolve(); return gate.promise; } });
  delete f.record.credentials.refreshToken;
  const old = f.fetch("grok");
  await entered.promise;
  f.replace(null);
  gate.resolve({ provider: "grok" });
  assert.match((await old).error, /凭据已变更/);
  assert.equal(f.publications.length, 0);
  assert.equal((await f.fetch("grok")).error, "未配置凭据");
});
