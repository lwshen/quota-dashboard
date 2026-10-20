const { test } = require("node:test");
const assert = require("node:assert/strict");
const { join } = require("node:path");
const { normalizeGrokCredentials, parseGrokAuthFile, grokTokenExpiresAt } = require(join(process.env.QUOTA_TEST_BUILD_DIR, "providers/grok-auth.js"));
const core = require(join(process.env.QUOTA_TEST_BUILD_DIR, "index.js"));

const now = new Date("2026-10-19T18:00:00Z");
const jwt = (claims) => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
const accessToken = jwt({ exp: now.getTime() / 1000 + 21600, principal_type: "User", principal_id: "test-user" });
const auth = (entry = {}, scope = "https://auth.x.ai::test-client") => ({ [scope]: {
  key: accessToken, refresh_token: "old-refresh", oidc_client_id: "test-client", oidc_issuer: "https://auth.x.ai", ...entry,
} });

test("Grok auth import selects OIDC accounts and sends only required fields", () => {
  const source = { ...auth({ email: "学习@example.test", unrelated_secret: "must-not-submit" }),
    "https://accounts.x.ai/sign-in": { key: "legacy" }, unrelated: { key: "another-secret" } };
  const accounts = parseGrokAuthFile(JSON.stringify(source));
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].label, "学习@example.test");
  assert.deepEqual(accounts[0].fields, { bearerToken: accessToken, refreshToken: "old-refresh", "extra.clientId": "test-client", expiresAt: "2026-10-20T00:00:00.000Z" });
  assert.ok(!JSON.stringify(accounts).includes("must-not-submit"));
});

test("Grok auth import returns multiple accounts for an explicit selection and supports the scope client ID", () => {
  const accounts = parseGrokAuthFile(JSON.stringify({ ...auth({}, "https://auth.x.ai::b"), ...auth({ oidc_client_id: "" }, "https://auth.x.ai::a") }));
  assert.equal(accounts.length, 2);
  assert.equal(accounts[0].fields["extra.clientId"], "a");
});

test("Grok auth import rejects malformed files and custom issuers without quoting secrets", () => {
  for (const source of ["bad-secret", "null", "[]", "{}", JSON.stringify(auth({ oidc_issuer: "https://attacker.test" }))]) {
    assert.throws(() => parseGrokAuthFile(source), (e) => !e.message.includes("bad-secret") && !e.message.includes("attacker.test"));
  }
});

test("manual Grok credentials validate refresh pairing and derive expiry and principal hints", () => {
  const creds = normalizeGrokCredentials({ bearerToken: ` Bearer ${accessToken} `, refreshToken: " refresh ", expiresAt: "2026-10-21T00:00:00Z", extra: { clientId: " client ", arbitrary: "discard" }, refreshState: { blocked: true } });
  assert.equal(creds.bearerToken, accessToken);
  assert.equal(creds.expiresAt, "2026-10-20T00:00:00.000Z");
  assert.deepEqual(creds.extra, { clientId: "client", principalType: "User", principalId: "test-user" });
  assert.equal(creds.refreshState, undefined);
  assert.throws(() => normalizeGrokCredentials({ bearerToken: "opaque-token", refreshToken: "secret" }), /Client ID/);
  assert.throws(() => normalizeGrokCredentials({ bearerToken: "opaque-token", expiresAt: "invalid" }), /过期时间/);
  assert.equal(normalizeGrokCredentials({ bearerToken: "opaque-token" }).expiresAt, null);
  for (const token of ["not-a-jwt", jwt({ exp: "123" }), jwt({ exp: 1e100 }), jwt({ exp: -1 })]) assert.equal(grokTokenExpiresAt(token), null);
});

const credentials = { bearerToken: "old-access", refreshToken: "old-refresh", expiresAt: now.toISOString(), extra: { clientId: "test-client", principalType: "User", principalId: "test-user" } };
function refreshContext(body, status = 200, headers = {}) {
  const calls = [];
  return { now, calls, http: { get: async () => { throw new Error("unexpected GET"); }, post: async (...args) => {
    calls.push(args);
    return { status, body: JSON.stringify(body), headers };
  } } };
}

test("Grok refresh matches the official OIDC form and persists rotated tokens and server TTL", async () => {
  const ctx = refreshContext({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 21600 });
  const { credentials: result } = await core.grokDescriptor.refresh(credentials, ctx);
  const [url, body, headers, options] = ctx.calls[0];
  assert.equal(url, "https://auth.x.ai/oauth2/token");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(body)), { grant_type: "refresh_token", refresh_token: "old-refresh", client_id: "test-client", principal_type: "User", principal_id: "test-user" });
  assert.equal(headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(options.retry, false);
  assert.equal(result.bearerToken, "new-access");
  assert.equal(result.refreshToken, "new-refresh");
  assert.equal(result.expiresAt, "2026-10-20T00:00:00.000Z");
  assert.equal(credentials.refreshToken, "old-refresh");
});

test("Grok refresh retains a non-rotated refresh token and clears obsolete expiry", async () => {
  const result = await core.grokDescriptor.refresh(credentials, refreshContext({ access_token: "new-access" }));
  assert.equal(result.credentials.refreshToken, "old-refresh");
  assert.equal(result.credentials.expiresAt, null);
  const withJwt = await core.grokDescriptor.refresh(credentials, refreshContext({ access_token: accessToken, expires_in: "bad" }));
  assert.equal(withJwt.credentials.expiresAt, "2026-10-20T00:00:00.000Z");
});

test("Grok refresh only classifies terminal OAuth errors on error responses and never exposes response bodies", async () => {
  for (const error of ["invalid_grant", "invalid_client"]) {
    await assert.rejects(core.grokDescriptor.refresh(credentials, refreshContext({ error, error_description: "old-refresh" }, 400)), (e) => e instanceof core.RefreshRejectedError && !e.message.includes("old-refresh"));
  }
  await assert.rejects(core.grokDescriptor.refresh(credentials, refreshContext({ error: "server_error", secret: "old-refresh" }, 500)), (e) => e instanceof core.UpstreamError && !e.message.includes("old-refresh"));
  await assert.rejects(core.grokDescriptor.refresh(credentials, refreshContext({ error: "invalid_grant" }, 429, { "retry-after": "120" })), (e) => e instanceof core.RateLimitedError && e.retryAfterSeconds === 120);
  for (const body of [null, [], {}, { access_token: 123 }, { access_token: "bad token" }]) {
    await assert.rejects(core.grokDescriptor.refresh(credentials, refreshContext(body)), core.UpstreamError);
  }
});

test("Grok refresh network errors and incomplete credentials are actionable and secret-free", async () => {
  const ctx = { now, http: { post: async () => { throw new Error("old-refresh"); } } };
  await assert.rejects(core.grokDescriptor.refresh(credentials, ctx), (e) => e instanceof core.UpstreamError && !e.message.includes("old-refresh"));
  await assert.rejects(core.grokDescriptor.refresh({ bearerToken: "access" }, ctx), core.RefreshRejectedError);
});

test("Grok permission failures do not trigger token renewal", async () => {
  const ctx = { now, http: { get: async () => ({ status: 403, body: "", headers: {} }), post: async () => ({ status: 403, body: "", headers: {} }) } };
  await assert.rejects(core.runPipeline(core.grokDescriptor, "oauth", { bearerToken: "access" }, ctx), (e) => e instanceof core.UpstreamError && e.status === 403);
});
