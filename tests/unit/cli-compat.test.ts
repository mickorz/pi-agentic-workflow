/**
 * V2-P1-07 CLI 兼容测试：V2 Web 线改动后 V1 CLI 行为不破（无 LLM 面：validate/list/help/退出码）。
 * 走真实子进程（node --import tsx src/cli/index.ts），非进程内直调。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(repoRoot, "src/cli/index.ts");

function cli(args: string[], opts: { cwd?: string } = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    cwd: opts.cwd ?? repoRoot,
    encoding: "utf-8",
    timeout: 60_000,
  });
}

test("CLI 兼容：validate 合法脚本退出 0 且输出 meta", () => {
  const res = cli(["validate", "examples/smoke.js"]);
  assert.equal(res.status, 0, `stdout=${res.stdout}\nstderr=${res.stderr}`);
  assert.ok(res.stdout.includes("name"), "输出应含 meta name");
});

test("CLI 兼容：validate 非法脚本退出 2；list 空目录退出 0；未知命令退出 2", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cli-compat-"));
  const bad = path.join(base, "bad.js");
  fs.writeFileSync(bad, "export const other = 1\n");

  const v = cli(["validate", bad]);
  assert.equal(v.status, 2, `stderr=${v.stderr}`);

  const l = cli(["list", "--cwd", base]);
  assert.equal(l.status, 0, `stderr=${l.stderr}`);
  assert.ok(l.stdout.includes("run"), "空列表也应正常渲染表头或提示");

  const unknown = cli(["no-such-command"]);
  assert.equal(unknown.status, 2);
});

test("CLI 兼容：--help 列出 V1 命令族且不依赖网络/LLM", () => {
  const res = cli(["--help"]);
  assert.equal(res.status, 0);
  for (const cmd of ["run", "resume", "stop", "list", "status", "validate", "route", "web"]) {
    assert.ok(res.stdout.includes(cmd), `--help 应包含 ${cmd}`);
  }
});
