import { readdirSync, readFileSync, existsSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const web = join(root, "apps/web");
const require = createRequire(join(web, "package.json"));
const ts = require("typescript");
const nodeBuiltins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", ".next", "tests", "data"].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : /\.tsx?$/.test(path) && !path.endsWith(".d.ts") ? [path] : [];
  });
}

function dependencies(source) {
  const imports = [];
  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      if (clause?.isTypeOnly || (bindings && ts.isNamedImports(bindings) && !clause.name
        && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly))) return;
      imports.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
      const elements = node.exportClause?.elements;
      if (!elements?.length || elements.some((element) => !element.isTypeOnly)) imports.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return imports;
}

const errors = new Set();
const graph = new Map();
const clientEntries = [];
for (const path of [...files(web), ...files(join(root, "packages/core/src"))]) {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const local = relative(web, path);
  const inCore = path.startsWith(join(root, "packages/core/src/"));
  const pure = local.startsWith("shared/");
  const edge = local.startsWith("runtime/") || local === "middleware.ts";
  const client = local.startsWith("client/") || local.startsWith("components/")
    || source.statements.some((statement) => ts.isExpressionStatement(statement) && statement.expression.text === "use client");
  if (client || pure || edge) clientEntries.push(path);
  const targets = [];
  for (const specifier of dependencies(source)) {
    const base = specifier.startsWith("@/") ? join(web, specifier.slice(2))
      : specifier.startsWith(".") ? resolve(dirname(path), specifier) : null;
    const target = base && [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]
      .find((candidate) => existsSync(candidate) && /\.tsx?$/.test(candidate));
    const targetLocal = target && relative(web, target);
    const fail = (reason) => errors.add(`${relative(root, path)} → ${specifier}: ${reason}`);
    if (base && !target && !/\.(css|svg|png|jpe?g|webp)$/.test(specifier)) fail("unresolved local module");
    if (target) targets.push(target);
    if ((pure || edge || client || inCore) && (nodeBuiltins.has(specifier) || specifier === "better-sqlite3")) {
      fail("Node-only dependency outside server/");
    }
    if (pure && targetLocal && !targetLocal.startsWith("shared/")) fail("shared/ must remain independent of application layers");
    if (edge && targetLocal && !targetLocal.startsWith("runtime/") && !targetLocal.startsWith("shared/")) fail("Edge code may only depend on runtime/ and shared/");
    if (inCore && (target?.startsWith(web + "/") || /^(next|react|react-dom)(\/|$)/.test(specifier))) fail("core must remain framework independent");
  }
  graph.set(path, targets);
}

// Follow local value imports so a client cannot pull secrets in through an intermediate module.
for (const entry of clientEntries) {
  const seen = new Set();
  function visit(path, chain) {
    if (seen.has(path)) return;
    seen.add(path);
    const local = relative(web, path);
    const browser = !relative(web, entry).startsWith("runtime/") && relative(web, entry) !== "middleware.ts";
    if (local.startsWith("server/") || (browser && local.startsWith("runtime/"))) {
      errors.add(`${chain.map((item) => relative(root, item)).join(" → ")}: forbidden runtime boundary`);
      return;
    }
    for (const next of graph.get(path) ?? []) visit(next, [...chain, next]);
  }
  visit(entry, [entry]);
}
if (errors.size) {
  console.error([...errors].join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Module boundaries verified (${graph.size} source files).`);
}
