const { existsSync, readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { dirname, join, relative: relativePath } = require("node:path");
const webRoot = join(__dirname, "../..");
const webRequire = createRequire(join(webRoot, "package.json"));
const ts = webRequire("typescript");

// Each fixture owns its cache and mocks; no Next server, poller, or real network is started.
function createWebLoader(mock = () => undefined) {
  const modules = new Map();
  function load(relative) {
    const base = join(webRoot, relative);
    const filename = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]
      .find((path) => /\.tsx?$/.test(path) && existsSync(path));
    if (!filename) throw new Error(`Cannot resolve web module: ${relative}`);
    const key = relativePath(webRoot, filename);
    if (modules.has(key)) return modules.get(key);
    const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
      fileName: filename,
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    });
    const module = { exports: {} };
    modules.set(key, module.exports);
    const resolve = (name) => {
      const mocked = mock(name);
      if (mocked !== undefined) return mocked;
      if (name === "@quota/core") return require(join(process.env.QUOTA_TEST_BUILD_DIR, "index.js"));
      if (name === "@quota/core/grok-auth") return require(join(process.env.QUOTA_TEST_BUILD_DIR, "providers/grok-auth.js"));
      if (name.startsWith("@/")) return load(name.slice(2));
      if (name.startsWith(".")) return load(join(dirname(key), name));
      return webRequire(name);
    };
    try {
      new Function("require", "module", "exports", outputText)(resolve, module, module.exports);
      modules.set(key, module.exports);
      return module.exports;
    } catch (error) {
      modules.delete(key);
      throw error;
    }
  }
  return { load, modules };
}

module.exports = { createWebLoader, webRequire };
