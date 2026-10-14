const { test } = require("node:test");
const assert = require("node:assert/strict");
const { join } = require("node:path");
const core = require(join(process.env.QUOTA_TEST_BUILD_DIR, "index.js"));
const { parseGrokCredits } = require(join(process.env.QUOTA_TEST_BUILD_DIR, "providers/grok-billing.js"));
const { parseGrokGrpc } = require(join(process.env.QUOTA_TEST_BUILD_DIR, "providers/grok-grpc.js"));

const now = new Date("2026-08-12T00:00:00Z");
const period = { start: "2026-08-06T00:00:00Z", end: "2026-08-13T00:00:00Z" };
const creds = { bearerToken: "test-token" };
const credits = (config, extra = {}) => JSON.stringify({ config, ...extra });
const parse = (config, extra) => parseGrokCredits(credits(config, extra), now);
const response = (body, status = 200, headers = {}) => ({ status, headers, body });

function varint(value) {
  value = BigInt(value);
  const bytes = [];
  do {
    bytes.push(Number(value & 127n) | (value > 127n ? 128 : 0));
    value >>= 7n;
  } while (value);
  return Buffer.from(bytes);
}
const scalar = (id, value) => Buffer.concat([varint(id * 8), varint(value)]);
const message = (id, bytes) => Buffer.concat([varint(id * 8 + 2), varint(bytes.length), bytes]);
const float = (id, value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeFloatLE(value);
  return Buffer.concat([varint(id * 8 + 5), bytes]);
};
const timestamp = (id, iso) => message(id, scalar(1, Date.parse(iso) / 1000));
const product = (id, percent) => message(7, Buffer.concat([scalar(1, id), float(2, percent)]));
const frame = (bytes, flag = 0) => {
  const head = Buffer.alloc(5);
  head[0] = flag;
  head.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([head, bytes]);
};
const grpc = (parts, trailers) => Buffer.concat([
  frame(message(1, Buffer.concat(parts))),
  ...(trailers ? [frame(Buffer.from(trailers), 128)] : []),
]);
const grpcResponse = (bytes, headers = {}) => ({ status: 200, headers, body: "", bodyBytes: bytes });
const activePeriod = () => message(8, Buffer.concat([
  scalar(1, 2), timestamp(2, period.start), timestamp(3, period.end),
]));

function context(getResponse, postResponse) {
  const calls = [];
  return {
    now, calls,
    http: {
      get: async (...args) => { calls.push(["GET", ...args]); return getResponse; },
      post: async (...args) => {
        calls.push(["POST", ...args]);
        if (postResponse instanceof Error) throw postResponse;
        assert.ok(postResponse, "unexpected web billing fallback");
        return postResponse;
      },
    },
  };
}
const fetchUsage = (ctx, credentials = creds, mode = "auto") => core.runPipeline(core.grokDescriptor, mode, credentials, ctx);

test("Grok is registered and available only with OAuth credentials in supported modes", async () => {
  assert.equal(core.isProvider("grok"), true);
  assert.equal(core.getDescriptor("grok"), core.grokDescriptor);
  assert.ok(core.listDescriptors().includes(core.grokDescriptor));
  const ctx = context(response(credits({ creditUsagePercent: 10 })));
  await assert.rejects(fetchUsage(ctx, {}), core.NotConfiguredError);
  await assert.rejects(fetchUsage(ctx, creds, "api"), core.NotConfiguredError);
  await assert.rejects(fetchUsage(ctx, creds, "web"), core.NotConfiguredError);
  assert.equal(ctx.calls.length, 0);
});

test("CLI billing request uses the official bearer headers and normalizes weekly usage", async () => {
  const ctx = context(response(credits({
    creditUsagePercent: 12.5, currentPeriod: period, subscriptionTier: "super_grok_heavy",
    onDemandCap: { val: 1000 }, onDemandUsed: { val: 900 }, prepaidBalance: { val: "1446" },
    productUsage: [{ product: "GrokBuild", usagePercent: 10 }, { product: "GrokChat", usagePercent: 2.5 }],
  })));
  const snapshot = await fetchUsage(ctx, { bearerToken: " Bearer test-token " }, "oauth");
  assert.deepEqual(ctx.calls[0], ["GET", "https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
    Authorization: "Bearer test-token", "x-xai-token-auth": "xai-grok-cli", Accept: "application/json",
    "User-Agent": "quota-dashboard",
  }, { timeoutMs: 15_000 }]);
  assert.equal(ctx.calls.length, 1);
  assert.deepEqual(snapshot.primary, {
    usedPercent: 12.5, usageKnown: true, windowMinutes: 10080,
    resetsAt: "2026-08-13T00:00:00.000Z", sourceKey: "credits",
  });
  assert.equal(snapshot.secondary, null);
  assert.equal(snapshot.dataConfidence, "exact");
  assert.equal(snapshot.identity.loginMethod, "Plan: SuperGrok Heavy");
  assert.deepEqual(snapshot.providerCost, { used: 0, limit: 0, balance: 14.46, currencyCode: "USD", period: "预付余额" });
  assert.deepEqual(snapshot.usageBreakdown.map((p) => p.title), ["Grok Build", "Grok Chat"]);
  assert.equal(snapshot.extraRateWindows, undefined);
  assert.ok(!JSON.stringify(snapshot).includes("test-token"));
});

test("missing percentage uses a finite on-demand ratio but never product shares", () => {
  const result = parse({ onDemandCap: { val: 200 }, onDemandUsed: { val: 50 }, productUsage: [{ product: "GrokBuild", usagePercent: 25 }] });
  assert.equal(result.usedPercent, 25);
  assert.equal(result.sourceKey, "on-demand");
  assert.deepEqual(result.products, []);
  assert.equal(parse({ creditUsagePercent: 150 }).usedPercent, 100);
  assert.equal(parse({ creditUsagePercent: -3 }).usedPercent, 0);
  for (const cap of [0, -1, "200", null]) {
    assert.equal(parse({ currentPeriod: period, onDemandCap: { val: cap }, onDemandUsed: { val: 50 } }).usedPercent, null);
  }
});

test("duration uses matching valid period bounds, never remaining time or a different cycle", () => {
  const cases = [
    [{ currentPeriod: period }, 10080],
    [{ billingPeriodStart: "2026-07-13T00:00:00Z", billingPeriodEnd: period.end }, 44640],
    [{ currentPeriod: { end: period.end }, billingPeriodStart: "2026-07-13T00:00:00Z" }, null],
    [{ currentPeriod: { start: "invalid", end: period.end } }, null],
    [{ currentPeriod: { start: period.end, end: "2026-08-20T00:00:00Z" } }, null],
    [{ currentPeriod: { start: period.start, end: period.start } }, null],
    [{ currentPeriod: { start: period.end, end: period.start } }, null],
    [{ currentPeriod: { start: "2026-01-01", end: "invalid" }, billingPeriodStart: period.start, billingPeriodEnd: period.end }, 10080],
  ];
  for (const [fields, minutes] of cases) assert.equal(parse({ creditUsagePercent: 10, ...fields }).windowMinutes, minutes);
});

test("wallet cents have strict units; malformed optional balances do not discard quota", () => {
  const cases = [[{ val: 1446 }, 14.46], [{ val: "1446" }, 14.46], [{}, 0], [{ val: 0 }, 0],
    [null, null], [[], null], ["1446", null], [{ val: -1 }, null], [{ val: "" }, null],
    [{ val: true }, null], [{ val: null }, null], [{ val: 1.5 }, null], [{ unknown: 0 }, null],
    [{ val: "9007199254740993" }, null]];
  for (const [wallet, expected] of cases) assert.equal(parse({ creditUsagePercent: 10, prepaidBalance: wallet }).balance, expected);
  assert.equal(parse({ prepaidBalance: {} }).balance, 0);
  assert.equal(parse({ prepaidBalance: { val: 100 } }).usedPercent, null);
});

test("product shares must completely compose the raw aggregate from the same response", () => {
  const good = [{ product: "GrokBuild", usagePercent: 20 }, { product: "GrokChat", usagePercent: 0 }];
  assert.equal(parse({ creditUsagePercent: 20, productUsage: good }).products.length, 1);
  assert.equal(parse({ creditUsagePercent: 120, productUsage: [{ product: "GrokBuild", usagePercent: 120 }] }).products[0].usedPercent, 120);
  for (const product of ["FutureProduct", "constructor", "__proto__"]) {
    assert.equal(parse({ creditUsagePercent: 20, productUsage: [{ product, usagePercent: 20 }] }).products[0].title, product);
  }
  for (const productUsage of ["bad", {}, [null], [...good, { product: "bad", usagePercent: "1" }],
    [...good, { product: "GrokBuild", usagePercent: 0 }], [{ product: "GrokBuild", usagePercent: -1 }],
    [{ product: "GrokBuild", usagePercent: 3 }]]) {
    assert.deepEqual(parse({ creditUsagePercent: 20, productUsage }).products, []);
  }
});

test("empty or malformed billing is an error, while period-only usage remains unknown", () => {
  for (const body of ["not JSON", "null", "[]", "{}", '{"config":[]}', credits({}), credits({ subscriptionTier: "Heavy" })]) {
    assert.throws(() => parseGrokCredits(body, now), core.UpstreamError);
  }
  assert.equal(parse({ currentPeriod: period, subscriptionTier: "Heavy" }).usedPercent, null);
});

test("a failed optional web lookup preserves unknown usage, reset time, plan and wallet", async () => {
  const ctx = context(response(credits({ currentPeriod: period, subscriptionTier: "Heavy", prepaidBalance: {} })), new Error("timeout"));
  const snapshot = await fetchUsage(ctx);
  assert.equal(snapshot.primary.usageKnown, false);
  assert.equal(snapshot.dataConfidence, "unknown");
  assert.equal(snapshot.primary.resetsAt, "2026-08-13T00:00:00.000Z");
  assert.equal(snapshot.providerCost.balance, 0);
  assert.equal(snapshot.identity.loginMethod, "Plan: SuperGrok Heavy");
  assert.equal(ctx.calls[1][4].timeoutMs, 6000);
  const previous = { ...snapshot, primary: { ...snapshot.primary, usageKnown: true, usedPercent: 99, resetsAt: "2026-08-06T00:00:00Z" } };
  assert.deepEqual(core.detectQuotaResets(previous, snapshot), []);
});

test("web enrichment preserves proxy period and plan, and drops proxy product shares", async () => {
  const ctx = context(response(credits({ currentPeriod: period, subscriptionTier: "SuperGrok", prepaidBalance: { val: 100 },
    productUsage: [{ product: "GrokBuild", usagePercent: 3 }],
  })), grpcResponse(grpc([float(1, 25), timestamp(5, "2026-09-01T00:00:00Z")])));
  const snapshot = await fetchUsage(ctx);
  assert.equal(snapshot.primary.usedPercent, 25);
  assert.equal(snapshot.primary.windowMinutes, 10080);
  assert.equal(snapshot.primary.resetsAt, "2026-08-13T00:00:00.000Z");
  assert.equal(snapshot.usageBreakdown, null);
  assert.equal(snapshot.providerCost.balance, 1);
  const call = ctx.calls[1];
  assert.equal(call[1], "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig");
  assert.deepEqual(Buffer.from(call[2]), Buffer.from([0, 0, 0, 0, 2, 8, 0]));
  assert.equal(call[3].Authorization, "Bearer test-token");
  assert.equal(call[3]["Content-Type"], "application/grpc-web+proto");
  assert.equal(call[4].retry, false);
});

test("explicit zero is trustworthy and does not trigger enrichment", async () => {
  const ctx = context(response(credits({ creditUsagePercent: 0, currentPeriod: period })));
  const snapshot = await fetchUsage(ctx);
  assert.equal(snapshot.primary.usedPercent, 0);
  assert.equal(snapshot.primary.usageKnown, true);
  assert.equal(ctx.calls.length, 1);
});

test("CLI failures fall back to bearer web billing without sending cookies", async () => {
  for (const status of [401, 403, 404, 500]) {
    const ctx = context(response("", status), grpcResponse(grpc([float(1, 7)])));
    assert.equal((await fetchUsage(ctx)).primary.usedPercent, 7);
    assert.equal(ctx.calls[1][3].Cookie, undefined);
  }
});

test("rate limits retain retry-after and do not trigger another upstream request", async () => {
  const ctx = context(response("", 429, { "retry-after": "120" }));
  await assert.rejects(fetchUsage(ctx), (e) => e instanceof core.RateLimitedError && e.retryAfterSeconds === 120);
  assert.equal(ctx.calls.length, 1);
});

test("expired and incorrect credentials give actionable errors without exposing tokens", async () => {
  for (const bearerToken of ["xai-secret", "Cookie: sso=secret", "sso=secret", "Bearer ", "bad\ntoken"]) {
    const ctx = context();
    await assert.rejects(fetchUsage(ctx, { bearerToken }), core.UnauthorizedError);
    assert.equal(ctx.calls.length, 0);
  }
  await assert.rejects(fetchUsage(context(), { ...creds, expiresAt: "2026-08-01T00:00:00Z" }), core.UnauthorizedError);
  const ctx = context(response("secret", 401), grpcResponse(grpc([], "grpc-status: 16\r\ngrpc-message: no-credentials\r\n")));
  await assert.rejects(fetchUsage(ctx), (e) => e instanceof core.UnauthorizedError && /grok login/.test(e.message) && !/secret/.test(e.message));
});

test("gRPC reads raw and framed floats, reset timestamps, and verified product IDs", () => {
  const parts = [float(1, 12.5), timestamp(5, period.end), product(2, 10), product(4, 2.5)];
  for (const bytes of [grpc(parts), message(1, Buffer.concat(parts))]) {
    const parsed = parseGrokGrpc(bytes, now);
    assert.equal(parsed.usedPercent, 12.5);
    assert.equal(parsed.resetsAt, "2026-08-13T00:00:00.000Z");
    assert.deepEqual(parsed.products.map((p) => p.title), ["Grok Build", "Grok Chat"]);
  }
});

test("gRPC zero requires a complete active period, not just a future reset", () => {
  const parsed = parseGrokGrpc(grpc([activePeriod()]), now);
  assert.equal(parsed.usedPercent, 0);
  assert.equal(parsed.windowMinutes, 10080);
  for (const bytes of [grpc([timestamp(5, period.end)]), grpc([activePeriod()]).subarray(0, -1),
    grpc([message(8, Buffer.concat([scalar(1, 2), timestamp(2, period.end), timestamp(3, "2026-08-20T00:00:00Z")]))]),
    Buffer.concat([grpc([activePeriod()]), grpc([activePeriod()])])]) {
    assert.throws(() => parseGrokGrpc(bytes, now), core.UpstreamError);
  }
});

test("gRPC nonzero status in headers or trailers overrides data and classifies failures", async () => {
  for (const headerStatus of [false, true]) {
    const bytes = grpc([float(1, 12)], headerStatus ? undefined : "grpc-status: 16\r\ngrpc-message: no%20credentials\r\n");
    const ctx = context(response("", 500), grpcResponse(bytes, headerStatus ? { "grpc-status": "16" } : {}));
    await assert.rejects(fetchUsage(ctx), core.UnauthorizedError);
  }
  const ctx = context(response("", 500), grpcResponse(grpc([], "grpc-status: 8\r\n")));
  await assert.rejects(fetchUsage(ctx), core.RateLimitedError);
  const team = context(response("", 500), grpcResponse(grpc([], "grpc-status: 9\r\ngrpc-message: No personal team.\r\n")));
  await assert.rejects(fetchUsage(team), /团队账户/);
});

test("gRPC rejects truncated frames, compressed flags, overflowing varints and invalid floats", () => {
  const valid = grpc([float(1, 10)]);
  const broken = [Buffer.alloc(0), valid.subarray(0, -1), Buffer.from([0, 255, 255, 255, 255]),
    frame(message(1, float(1, 10)), 1), frame(message(1, float(1, 10)), 2),
    grpc([float(1, NaN)]), grpc([float(1, Infinity)]), grpc([float(1, -1)]),
    frame(Buffer.from([10, 255, 255, 255, 255, 255, 255, 255, 255, 255, 2])),
    frame(Buffer.from([10, 4, 13, 0]))];
  for (const bytes of broken) assert.throws(() => parseGrokGrpc(bytes, now), core.UpstreamError);
});

test("gRPC malformed or mismatching product entries cannot masquerade as complete shares", () => {
  for (const entries of [[product(3, 10)], [product(2, 9), product(2, 1)], [product(2, 3)],
    [product(2, NaN)], [message(7, Buffer.concat([scalar(1, 2), float(2, 10), float(2, 10)]))]]) {
    const parsed = parseGrokGrpc(grpc([float(1, 10), ...entries]), now);
    assert.equal(parsed.usedPercent, 10);
    assert.deepEqual(parsed.products, []);
  }
});

test("HTTP transport preserves binary bytes without changing text callers", async (t) => {
  const bytes = grpc([float(1, 77.7)]);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return new Response(bytes, { headers: { "Content-Type": "application/grpc-web+proto" } });
  });
  const binary = await core.nodeHttpClient.post("https://example.test/billing", "\0", {}, { retry: false });
  assert.deepEqual(Buffer.from(binary.bodyBytes), bytes);
  assert.equal(binary.body, new TextDecoder().decode(bytes));
  assert.equal(calls[0].options.body, "\0");
  t.mock.method(globalThis, "fetch", async () => new Response('{"value":"用量"}'));
  const text = await core.nodeHttpClient.get("https://example.test/json", {}, { retry: false });
  assert.deepEqual(JSON.parse(text.body), { value: "用量" });
});
