const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createWebLoader } = require("./helpers/load-web.cjs");
const { parseCredentialJson, MAX_CREDENTIAL_IMPORT_BYTES } = createWebLoader().load("shared/credential-import.ts");

test("both Codex slots import auth.json, token objects, and form field objects", () => {
  const tokens = { access_token: " access ", refresh_token: " refresh ", account_id: " account ", id_token: "ignored" };
  for (const provider of ["codex", "codex2"]) {
    for (const input of [
      { tokens, OPENAI_API_KEY: "ignored", last_refresh: "ignored" },
      tokens,
      { access_token: "access", refresh_token: "refresh", account_id: "account" },
      { bearerToken: "access", refreshToken: "refresh", accountId: "account" },
      { accessToken: "access", refreshToken: "refresh", accountId: "account" },
      { tokens: { access_token: "access", refresh_token: "refresh" }, account_id: "account" },
    ]) {
      assert.deepEqual(parseCredentialJson(provider, JSON.stringify(input)), {
        bearerToken: "access", refreshToken: "refresh", accountId: "account",
      });
    }
  }
});

test("Claude imports only the selected OAuth fields from full files and flat objects", () => {
  const tokens = { accessToken: " access ", refreshToken: " refresh ", expiresAt: 1800000000000, scopes: ["user:inference"] };
  for (const input of [
    { claudeAiOauth: tokens, mcpOAuth: { secret: "ignored" }, accountId: "ignored" },
    tokens,
    { bearerToken: "access", refreshToken: "refresh" },
    { access_token: "access", refresh_token: "refresh" },
  ]) {
    assert.deepEqual(parseCredentialJson("claude", JSON.stringify(input)), { bearerToken: "access", refreshToken: "refresh" });
  }
});

test("imports omit empty optional fields and handle BOM-prefixed files", () => {
  for (const provider of ["codex", "codex2", "claude"]) {
    assert.deepEqual(parseCredentialJson(provider, '\uFEFF {"bearerToken":" access ","refreshToken":null,"accountId":""}'), { bearerToken: "access" });
  }
});

test("invalid JSON, token types, wrong-provider files, and API-key-only files fail without echoing credentials", () => {
  const secret = "synthetic-secret-never-echo";
  for (const provider of ["codex", "codex2", "claude"]) {
    for (const source of [
      "", "{", JSON.stringify(secret), "null", "[]", "123", "true", "{}",
      JSON.stringify({ bearerToken: 123 }), JSON.stringify({ bearerToken: {} }),
      JSON.stringify({ bearerToken: "   " }), JSON.stringify({ bearerToken: secret, refreshToken: [] }),
      JSON.stringify({ OPENAI_API_KEY: secret }), JSON.stringify({ ANTHROPIC_API_KEY: secret }),
    ]) {
      assert.throws(() => parseCredentialJson(provider, source), (error) => !error.message.includes(secret));
    }
  }
  for (const [provider, wrapper] of [["codex", "tokens"], ["claude", "claudeAiOauth"]]) {
    for (const value of [null, [], "invalid", 123]) {
      assert.throws(() => parseCredentialJson(provider, JSON.stringify({ [wrapper]: value, bearerToken: "must-not-fallback" })));
    }
    assert.throws(() => parseCredentialJson(provider, JSON.stringify({ [wrapper]: {}, bearerToken: "must-not-mix" })));
  }
  assert.throws(() => parseCredentialJson("codex", '{"claudeAiOauth":{"accessToken":"claude-access"}}'));
  assert.throws(() => parseCredentialJson("claude", '{"tokens":{"access_token":"codex-access"}}'));
  assert.throws(() => parseCredentialJson("codex", '{"access_token":"access","account_id":42}'));
});

test("the JSON size limit counts UTF-8 bytes, for both file and pasted content", () => {
  assert.throws(() => parseCredentialJson("codex", " ".repeat(MAX_CREDENTIAL_IMPORT_BYTES + 1)), /过大/);
  assert.throws(() => parseCredentialJson("claude", JSON.stringify({ accessToken: "access", ignored: "中".repeat(MAX_CREDENTIAL_IMPORT_BYTES / 2) })), /过大/);
});
