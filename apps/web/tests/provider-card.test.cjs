const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { join } = require("node:path");
const webRequire = createRequire(join(__dirname, "../package.json"));
const ts = webRequire("typescript");
const React = webRequire("react");
const { renderToStaticMarkup } = webRequire("react-dom/server");
const core = require(join(process.env.QUOTA_TEST_BUILD_DIR, "index.js"));

// Load the real presentation modules with their browser aliases, without starting a server or poller.
const modules = new Map();
function load(relative) {
  if (modules.has(relative)) return modules.get(relative);
  const filename = join(__dirname, "..", relative);
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
    fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  const require = (name) => name === "@/lib/format" ? load("lib/format.ts")
    : name === "./RateWindowBar" ? load("components/RateWindowBar.tsx") : webRequire(name);
  new Function("require", "module", "exports", outputText)(require, module, module.exports);
  modules.set(relative, module.exports);
  return module.exports;
}
const { ProviderCard } = load("components/ProviderCard.tsx");
const { formatCost, laneMeta } = load("lib/format.ts");
const now = new Date("2026-10-25T12:00:00Z");
const render = (snapshot) => renderToStaticMarkup(React.createElement(ProviderCard, {
  view: { provider: snapshot.provider, label: snapshot.provider, snapshot, error: null, fetchedAt: now.toISOString() },
  now: now.getTime(), authed: true,
}));
async function parse(provider, body) {
  return core.runPipeline(core.getDescriptor(provider), "auto", { bearerToken: "synthetic" }, {
    now, http: { get: async () => ({ status: 200, body: JSON.stringify(body), headers: {} }) },
  });
}

test("card shows actual Kimi duration and trusts each window independently", async () => {
  const snapshot = await parse("kimi", { usage: { limit: "100" }, limits: [{ window: { duration: 2, timeUnit: "TIME_UNIT_HOUR" }, detail: { limit: "100", used: "20" } }] });
  const html = render(snapshot);
  assert.match(html, /2小时速率/);
  assert.match(html, /未知 · unknown/);
  assert.match(html, /20%/);
  assert.equal((html.match(/class="bar"/g) ?? []).length, 1);
  assert.equal(laneMeta("kimi", "secondary", null).title, "速率");
});

test("card renders ratio-only Kimi monthly quota and every inactive Claude model quota", async () => {
  assert.match(render(await parse("kimi", { usages: { limit_month_total: { used_ratio: 0.42 } } })), /42%/);
  const snapshot = await parse("claude", { limits: ["Fable", "Example Model"].map((name) => ({
    kind: "weekly_scoped", group: "weekly", percent: 25, is_active: false, scope: { model: { display_name: name } },
  })) });
  const html = render(snapshot);
  assert.match(html, /Fable \(7d\)/);
  assert.match(html, /Example Model \(7d\)/);
});

test("card shows zero credits as zero and preserves both monthly quota and independent balance", async () => {
  const empty = render(await parse("codex", { credits: { has_credits: true, balance: 0 } }));
  assert.match(empty, /0\.00 Credits/);
  assert.doesNotMatch(empty, /∞|USD/);
  const combined = render(await parse("codex2", { individual_limit: { limit: 1000, used: 250 }, credits: { has_credits: true, balance: 40 } }));
  assert.match(combined, /250\.00 \/ 1000\.00 Credits/);
  assert.match(combined, /余额 40\.00 Credits/);
  assert.equal(formatCost({ limit: 0, used: 0, balance: 0, currencyCode: "USD" }), "0.00 USD");
  assert.equal(formatCost({ limit: 25, used: 0, currencyCode: "USD", period: "Credits balance" }), "25.00 USD");
  assert.equal(formatCost({ limit: 0, used: 0, currencyCode: "USD", period: "Credits balance" }), "0.00 USD");
});
