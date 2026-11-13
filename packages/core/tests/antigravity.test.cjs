const { test } = require("node:test");
const assert = require("node:assert/strict");
const { join } = require("node:path");
const core = require(join(process.env.QUOTA_TEST_BUILD_DIR, "index.js"));

const now = new Date("2026-11-13T12:00:00Z");
const reset5h = "2026-11-13T17:00:00.000Z";
const reset7d = "2026-11-20T12:00:00.000Z";

function makeJwt(payload) {
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(payload)}.sig`;
}

function createMockHttp(routes) {
  const calls = [];
  return {
    calls,
    post: async (url, body, headers, opts) => {
      calls.push({ url, body: body ? JSON.parse(body) : null, headers, opts });
      const handler = routes[url];
      assert.ok(handler, `unexpected POST to ${url}`);
      const res = typeof handler === "function" ? await handler(body ? JSON.parse(body) : null, headers, opts) : handler;
      if (res instanceof Error) throw res;
      return {
        status: res.status ?? 200,
        headers: res.headers ?? {},
        body: typeof res.body === "string" ? res.body : JSON.stringify(res.body ?? res),
      };
    },
  };
}

test("Antigravity parses retrieveUserQuotaSummary groups, normalizes titles/order, and maps 5h + weekly windows", async () => {
  const idToken = makeJwt({ email: "dev@example.com" });
  const http = createMockHttp({
    "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist": {
      cloudaicompanionProject: "proj-123",
      paidTier: { id: "g1-pro-tier", name: "Google AI Pro" },
      currentTier: { id: "standard-tier", name: "Standard" },
    },
    "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary": {
      response: {
        groups: [
          {
            displayName: "Claude & GPT Models",
            buckets: [
              { bucketId: "claude-weekly", displayName: "Weekly Limit", remainingFraction: 0.4, resetTime: reset7d },
              { bucketId: "claude-5h", displayName: "5-Hour Limit", remaining: { case: "remainingFraction", value: 0.75 }, resetTime: reset5h },
            ],
          },
          {
            displayName: "Gemini 4 Argon",
            buckets: [
              { bucketId: "argon-weekly", displayName: "Weekly", remainingFraction: 0.9, resetTime: reset7d },
            ],
          },
          {
            displayName: "Gemini Models",
            buckets: [
              { bucketId: "gemini-weekly", displayName: "Weekly", remainingFraction: 0.6, resetTime: reset7d },
              { bucketId: "gemini-session", window: "session", displayName: "Session", remainingFraction: 0.8, resetTime: reset5h, description: "80/100 remaining" },
              { bucketId: "gemini-disabled", displayName: "Disabled", remainingFraction: 0.5, disabled: true },
            ],
          },
        ],
      },
    },
  });

  const snapshot = await core.runPipeline(
    core.getDescriptor("antigravity"),
    "auto",
    { bearerToken: "ya29.test", extra: { idToken } },
    { now, http },
  );

  assert.equal(snapshot.provider, "antigravity");
  assert.equal(snapshot.primary, null);
  assert.equal(snapshot.secondary, null);
  assert.equal(snapshot.dataConfidence, "exact");
  assert.equal(snapshot.identity.accountEmail, "dev@example.com");
  assert.equal(snapshot.identity.loginMethod, "Plan: Google AI Pro");
  assert.deepEqual(
    snapshot.extraRateWindows.map((w) => [w.id, w.title, Math.round(w.window.usedPercent), w.window.windowMinutes, w.usageKnown]),
    [
      ["antigravity-quota-summary-gemini-session", "Gemini 5-hour", 20, 300, true],
      ["antigravity-quota-summary-gemini-weekly", "Gemini weekly", 40, 10080, true],
      ["antigravity-quota-summary-gemini-disabled", "Gemini Disabled", 0, null, false],
      ["antigravity-quota-summary-claude-5h", "Claude/GPT 5-hour", 25, 300, true],
      ["antigravity-quota-summary-claude-weekly", "Claude/GPT weekly", 60, 10080, true],
      ["antigravity-quota-summary-argon-weekly", "Gemini 4 Argon weekly", 10, 10080, true],
    ],
  );
  assert.equal(http.calls[1].body.project, "proj-123");
});

test("Antigravity suppresses contradictory Free plan when an active 5-hour summary bucket is present", async () => {
  const http = createMockHttp({
    "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist": {
      cloudaicompanionProject: { id: "proj-free" },
      currentTier: { id: "free-tier", name: "Free" },
    },
    "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary": {
      groups: [
        {
          name: "Gemini",
          buckets: [{ id: "gemini-5-hour", remainingFraction: 0.5, resetTime: reset5h }],
        },
      ],
    },
  });

  const snapshot = await core.runPipeline(
    core.getDescriptor("antigravity"),
    "auto",
    { bearerToken: "ya29.test", extra: { email: "user@gmail.com" } },
    { now, http },
  );
  assert.equal(snapshot.identity.accountEmail, "user@gmail.com");
  assert.equal(snapshot.identity.loginMethod, null);
});

test("Antigravity onboards project when loadCodeAssist omits cloudaicompanionProject and resolves Workspace plan", async () => {
  const idToken = makeJwt({ email: "alice@corp.example.com", hd: "corp.example.com" });
  const http = createMockHttp({
    "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist": {
      currentTier: { id: "free-tier" },
      allowedTiers: [{ id: "other-tier" }, { id: "default-tier", isDefault: true }],
    },
    "https://cloudcode-pa.googleapis.com/v1internal:onboardUser": (body) => {
      assert.equal(body.tierId, "default-tier");
      return { response: { cloudaicompanionProject: { projectId: "onboarded-proj-99" } } };
    },
    "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary": (body) => {
      assert.equal(body.project, "onboarded-proj-99");
      return {
        groups: [{ name: "Gemini", buckets: [{ id: "gemini-weekly", remainingFraction: 0.7, resetTime: reset7d }] }],
      };
    },
  });

  const snapshot = await core.runPipeline(
    core.getDescriptor("antigravity"),
    "auto",
    { bearerToken: "ya29.test", extra: { idToken } },
    { now, http },
  );
  assert.equal(snapshot.identity.loginMethod, "Plan: Workspace");
  assert.equal(snapshot.extraRateWindows[0].window.usedPercent, 30);
});

test("Antigravity rejects unenrolled consumer OAuth client when GOOGLE_TOS_NOT_SUPPORTED_BY_CLIENT is returned", async () => {
  const http = createMockHttp({
    "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist": {
      ineligibleTiers: [{ reasonCode: "GOOGLE_TOS_NOT_SUPPORTED_BY_CLIENT" }],
    },
  });

  await assert.rejects(
    core.runPipeline(core.getDescriptor("antigravity"), "auto", { bearerToken: "ya29.test" }, { now, http }),
    (err) => err instanceof core.UnauthorizedError && /个人账户配额/.test(err.message),
  );
});

test("Antigravity falls back to fetchAvailableModels, canonicalizes retired Flash, and deduplicates model pools", async () => {
  const http = createMockHttp({
    "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist": {
      cloudaicompanionProject: "proj-models",
      currentTier: { id: "standard-tier" },
    },
    "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary": { status: 404, body: {} },
    "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels": {
      models: {
        "gemini-2.5-pro": { displayName: "Gemini 2.5 Pro", quotaInfo: { remainingFraction: 0.65, resetTime: reset5h } },
        "gemini-3.6-flash": { displayName: "Gemini 3.6 Flash", quotaInfo: { remainingFraction: 0.4, resetTime: reset5h } },
        "gemini-3.5-flash": { displayName: "Gemini 3.5 Flash", quotaInfo: { remainingFraction: 0.8, resetTime: reset5h } },
        "gemini-2.5-flash-lite": { displayName: "Gemini 2.5 Flash Lite", quotaInfo: { remainingFraction: 0.1, resetTime: reset5h } },
        "claude-3-5-sonnet-thinking": { quotaInfo: { remainingFraction: 0.3, resetTime: reset7d } },
        "gpt-4o": { displayName: "GPT-4o", quotaInfo: { remainingFraction: 0.3, resetTime: reset7d } },
        "claude-3-7-opus": { quotaInfo: { remainingFraction: 0.9, resetTime: reset7d } },
        "internal-model": { isInternal: true, quotaInfo: { remainingFraction: 0.01, resetTime: reset5h } },
      },
    },
  });

  const snapshot = await core.runPipeline(
    core.getDescriptor("antigravity"),
    "auto",
    { bearerToken: "ya29.test" },
    { now, http },
  );

  assert.equal(Math.round(snapshot.primary.usedPercent), 35);
  assert.equal(Math.round(snapshot.secondary.usedPercent), 70);
  assert.deepEqual(
    snapshot.extraRateWindows.map((w) => [w.id, w.title, Math.round(w.window.usedPercent)]),
    [
      ["gemini-3-7-flash", "Gemini 3.7 Flash", 60],
      ["claude-3-7-opus", "Claude 3.7 Opus", 10],
    ],
  );
});

test("Antigravity verifies suspicious all-100% fetchAvailableModels responses with retrieveUserQuota", async () => {
  for (const [verifyResponse, expectedPrimary] of [
    [{ status: 403, body: {} }, null],
    [{ buckets: [{ modelId: "gemini-2.5-pro", resetTime: reset5h }] }, null],
    [{ buckets: [{ modelId: "gemini-2.5-pro", remainingFraction: 0.25, resetTime: reset5h }] }, 75],
  ]) {
    const http = createMockHttp({
      "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist": {
        cloudaicompanionProject: "proj-verify",
        currentTier: { id: "standard-tier" },
      },
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary": { status: 500, body: {} },
      "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels": {
        models: {
          "gemini-2.5-pro": { displayName: "Gemini 2.5 Pro", quotaInfo: { remainingFraction: 1, resetTime: reset5h } },
        },
      },
      "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota": verifyResponse,
    });

    const snapshot = await core.runPipeline(
      core.getDescriptor("antigravity"),
      "auto",
      { bearerToken: "ya29.test" },
      { now, http },
    );
    assert.equal(snapshot.primary ? Math.round(snapshot.primary.usedPercent) : null, expectedPrimary);
    assert.equal(snapshot.identity.loginMethod, "Plan: Paid");
  }
});

test("Antigravity refreshes OAuth tokens with client_id + client_secret and updates id_token email claims", async () => {
  const descriptor = core.getDescriptor("antigravity");
  await assert.rejects(
    descriptor.refresh({ bearerToken: "old", refreshToken: "rt" }, { now, http: {} }),
    (err) => err instanceof core.RefreshRejectedError && /Client Secret/.test(err.message),
  );

  let capturedForm;
  const idToken = makeJwt({ email: "refreshed@corp.example.com", hd: "corp.example.com" });
  const { credentials: rotated } = await descriptor.refresh(
    {
      bearerToken: "old-access",
      refreshToken: "old-refresh",
      extra: { clientSecret: "GOCSPX-secret", projectId: "proj-1" },
    },
    {
      now,
      http: {
        post: async (url, body, headers, opts) => {
          assert.equal(url, "https://oauth2.googleapis.com/token");
          assert.equal(headers["Content-Type"], "application/x-www-form-urlencoded");
          assert.equal(opts.retry, false);
          capturedForm = Object.fromEntries(new URLSearchParams(body));
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({
              access_token: "new-access",
              refresh_token: "new-refresh",
              expires_in: 3600,
              id_token: idToken,
            }),
          };
        },
      },
    },
  );

  assert.equal(capturedForm.client_id, core.ANTIGRAVITY_DEFAULT_CLIENT_ID);
  assert.equal(capturedForm.client_secret, "GOCSPX-secret");
  assert.equal(capturedForm.refresh_token, "old-refresh");
  assert.equal(capturedForm.grant_type, "refresh_token");
  assert.equal(rotated.bearerToken, "new-access");
  assert.equal(rotated.refreshToken, "new-refresh");
  assert.equal(rotated.expiresAt, "2026-11-13T13:00:00.000Z");
  assert.equal(rotated.extra.projectId, "proj-1");
  assert.equal(rotated.extra.email, "refreshed@corp.example.com");
  assert.equal(rotated.extra.hostedDomain, "corp.example.com");
});
