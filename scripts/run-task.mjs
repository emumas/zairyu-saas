#!/usr/bin/env node
/**
 * Turbo でタスクを動かす。Turbo が起動できない環境(Windows のセキュリティ機能が実行ファイルを止める
 * 「spawn UNKNOWN」など)では、pnpm の再帰実行に切り替える(依存の順にビルドしてから実行する)。
 *   node scripts/run-task.mjs build | test | typecheck | dev
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const task = process.argv[2];
const extra = process.argv.slice(3);
if (!["build", "test", "typecheck", "dev"].includes(task ?? "")) {
  console.error("使い方: node scripts/run-task.mjs build|test|typecheck|dev");
  process.exit(1);
}

const run = (cmd, args) => spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" }).status ?? 1;

function turboWorks() {
  try {
    const bin = createRequire(import.meta.url).resolve("turbo/bin/turbo");
    const r = spawnSync(process.execPath, [bin, "--version"], { stdio: "pipe", timeout: 30_000 });
    return r.status === 0 ? bin : null;
  } catch {
    return null;
  }
}

const turbo = turboWorks();
if (turbo) {
  const args = task === "dev" ? ["run", "dev", "--filter=api", ...extra] : ["run", task, ...extra];
  process.exit(run(process.execPath, [turbo, ...args]));
}

console.warn(`[run-task] Turbo を起動できないため、pnpm で順に実行します(${task})`);
// ライブラリ(packages/*)を依存の順にビルドする(pnpm -r は依存関係の順に実行する)
const buildPackages = () => run("pnpm", ["-r", "--filter", "./packages/**", "run", "build"]);
let code;
switch (task) {
  case "build":
    code = run("pnpm", ["-r", "run", "build", ...extra]);
    break;
  case "test":
  case "typecheck":
    code = buildPackages() || run("pnpm", ["-r", "run", task, ...extra]);
    break;
  case "dev":
    code = buildPackages() || run("pnpm", ["--filter", "api", "run", "dev", ...extra]);
    break;
}
process.exit(code);
