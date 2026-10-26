const { test } = require("node:test");
const assert = require("node:assert/strict");
const { join } = require("node:path");
const core = require(join(process.env.QUOTA_TEST_BUILD_DIR, "index.js"));
const now = new Date("2026-10-25T12:00:00Z");
const credentials = { bearerToken: "old-access", refreshToken: "old-refresh", accountId: "test-account", expiresAt: "2026-10-26T00:00:00Z" };
const response = (status, json, headers = {}) => ({ status, body: JSON.stringify(json), headers });

for (const provider of ["codex", "codex2", "claude"]) {
  const descriptor = core.getDescriptor(provider);
  test(`${provider} classifies all supported permanent OAuth error shapes without exposing response data`, async () => {
    for (const error of ["invalid_grant", "invalid_client", "refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated"]) {
      for (const body of [{ error }, { error: { code: error } }, { code: error }]) {
        body.error_description = "sensitive-old-refresh";
        await assert.rejects(descriptor.refresh(credentials, { now, http: { post: async () => response(400, body) } }), (e) => {
          assert.ok(e instanceof core.RefreshRejectedError);
          assert.doesNotMatch(e.message, /sensitive|old-refresh|\[object Object\]/);
          return true;
        });
      }
    }
  });

  test(`${provider} handles rate limits and transient refresh errors without a permanent block`, async () => {
    await assert.rejects(descriptor.refresh(credentials, { now, http: { post: async () => response(429, { error: "invalid_grant" }, { "retry-after": "120" }) } }),
      (e) => e instanceof core.RateLimitedError && e.retryAfterSeconds === 120);
    await assert.rejects(descriptor.refresh(credentials, { now, http: { post: async () => response(503, { error: "temporarily_unavailable" }) } }),
      (e) => e instanceof core.UpstreamError && !(e instanceof core.RefreshRejectedError));
  });

  test(`${provider} saves rotations and server expiry while disabling transport retry`, async () => {
    let request;
    const { credentials: rotated } = await descriptor.refresh(credentials, { now, http: { post: async (...args) => {
      request = args;
      return response(200, { access_token: "new-access", refresh_token: "new-refresh", expires_in: "3600" });
    } } });
    assert.equal(rotated.bearerToken, "new-access");
    assert.equal(rotated.refreshToken, "new-refresh");
    assert.equal(rotated.accountId, credentials.accountId);
    assert.equal(rotated.expiresAt, "2026-10-25T13:00:00.000Z");
    assert.equal(request[3].retry, false);
    const form = provider === "claude" ? Object.fromEntries(new URLSearchParams(request[1])) : JSON.parse(request[1]);
    assert.equal(form.refresh_token, credentials.refreshToken);
    assert.equal(form.grant_type, "refresh_token");
    const retained = (await descriptor.refresh(credentials, { now, http: { post: async () => response(200, { access_token: "new-access" }) } })).credentials;
    assert.equal(retained.refreshToken, credentials.refreshToken);
    assert.equal(retained.expiresAt, null);
  });

  test(`${provider} rejects successful refresh responses without a valid new access token`, async () => {
    for (const body of [{}, [], null, { access_token: "" }, { access_token: "bad token" }, { access_token: 123 }]) {
      await assert.rejects(descriptor.refresh(credentials, { now, http: { post: async () => response(200, body) } }), core.UpstreamError);
    }
  });

  test(`${provider} permanent renewal failure stays blocked across fetcher restarts and clears with replacement`, async () => {
    let record = { enabled: true, mode: "oauth", credentials, revision: "1" };
    let sequence = 1, gets = 0, posts = 0;
    const deps = {
      now: () => now,
      load: () => record,
      update: (_provider, next, _date, revision) => {
        assert.equal(revision, record.revision);
        record = { ...record, credentials: next, revision: String(++sequence) };
        return record.revision;
      },
      publish: () => {},
      http: () => ({
        get: async () => { gets++; return response(record.credentials.bearerToken === "replacement" ? 200 : 401, { five_hour: { utilization: 10 } }); },
        post: async () => { posts++; return response(400, { error: { code: "refresh_token_reused" } }); },
      }),
    };
    assert.ok((await core.createUsageFetcher(deps)(provider)).error);
    assert.equal(record.credentials.refreshState.blocked, true);
    assert.ok((await core.createUsageFetcher(deps)(provider)).error);
    assert.equal(posts, 1);
    assert.equal(gets, 1);
    record = { ...record, credentials: { bearerToken: "replacement" }, revision: String(++sequence) };
    assert.equal((await core.createUsageFetcher(deps)(provider)).error, null);
    assert.equal(gets, 2);
  });
}

test("Codex permission errors do not rotate refresh tokens", async () => {
  let refreshes = 0;
  const fetch = core.createUsageFetcher({
    load: () => ({ enabled: true, mode: "oauth", revision: "1", credentials }),
    update: () => { throw new Error("unexpected credential update"); }, publish: () => {}, now: () => now,
    http: () => ({ get: async () => response(403, {}), post: async () => { refreshes++; return response(200, {}); } }),
  });
  assert.match((await fetch("codex")).error, /403/);
  assert.equal(refreshes, 0);
});
