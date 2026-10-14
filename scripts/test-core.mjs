import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, "packages/core/package.json"));
const buildDir = mkdtempSync(join(tmpdir(), "quota-core-tests-"));
try {
  execFileSync(process.execPath, [
    require.resolve("typescript/bin/tsc"), "-p", join(root, "packages/core/tsconfig.json"),
    "--outDir", buildDir, "--module", "commonjs", "--moduleResolution", "node",
  ], { stdio: "inherit" });
  const tests = readdirSync(join(root, "packages/core/tests"))
    .filter((name) => name.endsWith(".test.cjs"))
    .map((name) => join(root, "packages/core/tests", name));
  const result = spawnSync(process.execPath, ["--test", ...tests], {
    stdio: "inherit", env: { ...process.env, QUOTA_TEST_BUILD_DIR: buildDir },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(buildDir, { recursive: true, force: true });
}
