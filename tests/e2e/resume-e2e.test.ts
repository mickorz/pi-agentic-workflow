/**
 * P2 e2e：故障注入 + resume 恢复（需真实模型凭证）
 *
 * 场景（P2-01/P2-04/P2-07 真实证据）：
 *  1. 3 节点 workflow 以 CLI 子进程运行（真实 Pi SDK + 真实模型）
 *  2. 监测 journal.jsonl 出现 2 条后 SIGKILL 强杀（模拟 crash：manifest 残留 running）
 *  3. list 应显示 interrupted（死进程补偿态）
 *  4. resume --yes --non-interactive：前两节点 journal 回放（不调模型），第三节点执行
 *  5. 断言：完成态、回放标记、journal 3 条、token 仅产生于第三节点
 *
 * 运行：PI_WORKFLOW_INTEGRATION=1 npm run test:e2e（需先 npm run build）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const explicit = process.env.PI_WORKFLOW_INTEGRATION === "1";
const CLI = path.resolve("dist/cli/index.js");

const WORKFLOW = `export const meta = { name: "resume_e2e", phases: [{ title: "chain" }] }
phase("chain")
const a = await agent("Reply with exactly: node-1-done", { label: "n1" })
const b = await agent("Reply with exactly: node-2-done", { label: "n2" })
const c = await agent("Reply with exactly: node-3-done", { label: "n3" })
return [a, b, c]`;

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, onSpawn?: (child: ChildProcess) => void): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
    onSpawn?.(child);
  });
}

function waitJournalLines(file: string, count: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (fs.existsSync(file)) {
        const lines = fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim().length > 0);
        if (lines.length >= count) return resolve();
      }
      if (Date.now() - start > timeoutMs) return reject(new Error(`等待 journal ${count} 条超时`));
      setTimeout(tick, 300);
    };
    tick();
  });
}

test("P2 e2e：强杀后 resume 回放不重复请求已提交节点", { skip: !explicit ? "set PI_WORKFLOW_INTEGRATION=1 to run" : false }, async (t) => {
  assert.ok(fs.existsSync(CLI), "先 npm run build 生成 dist/cli/index.js");
  const runtime = await ModelRuntime.create();
  const available = await runtime.getAvailable();
  const model = available[0];
  if (!model) return t.skip("无可用模型凭证，跳过 e2e");
  const modelSpec = `${model.provider}/${model.id}`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-e2e-"));
  const scriptPath = path.join(dir, "wf.js");
  fs.writeFileSync(scriptPath, WORKFLOW);
  try {
    // 1) 启动并在 2 条 journal 后强杀
    const childPromise = runCli(
      ["run", "wf.js", "--cwd", dir, "--model", modelSpec, "--json"],
      dir,
      (child) => {
        void waitJournalLines(path.join(dir, ".pi-workflows"), 0, 1).catch(() => {});
        void (async () => {
          try {
            // 找到该 run 的 journal 文件（runId 未知，扫描 runs/*/journal.jsonl）
            const runsDir = path.join(dir, ".pi-workflows", "runs");
            await new Promise<void>((resolve, reject) => {
              const start = Date.now();
              const tick = () => {
                if (fs.existsSync(runsDir)) {
                  const dirs = fs.readdirSync(runsDir);
                  if (dirs.length > 0) return resolve();
                }
                if (Date.now() - start > 30_000) return reject(new Error("runs 目录未创建"));
                setTimeout(tick, 200);
              };
              tick();
            });
            const runId = fs.readdirSync(path.join(dir, ".pi-workflows", "runs"))[0];
            assert.ok(runId, "runId 存在");
            await waitJournalLines(path.join(dir, ".pi-workflows", "runs", runId, "journal.jsonl"), 2, 180_000);
            // 2 条 journal 已落盘 → SIGKILL 模拟 crash
            process.kill(child.pid!, "SIGKILL");
          } catch {
            // 超时兜底：不强杀，让用例失败于后续断言
          }
        })();
      },
    );
    const killed = await childPromise;
    assert.ok(killed.code === null || killed.code !== 0, `强杀后退出码应为非正常：${killed.code}`);

    // 2) list 显示 interrupted
    const runsDir = path.join(dir, ".pi-workflows", "runs");
    const runId = fs.readdirSync(runsDir)[0]!;
    const listOut = await runCli(["list"], dir);
    assert.match(listOut.stdout, /interrupted/, `list 应含 interrupted：\n${listOut.stdout}`);

    // 3) 非交互且无 --yes → 拒绝（副作用窗口防护，P2-04）
    const refused = await runCli(["resume", runId, "--non-interactive"], dir);
    assert.notEqual(refused.code, 0, "副作用确认未决应拒绝");

    // 4) resume --yes --non-interactive：回放前两节点
    const resumed = await runCli(
      ["resume", runId, "--yes", "--non-interactive", "--model", modelSpec, "--json"],
      dir,
    );
    assert.equal(resumed.code, 0, `resume 应成功：\n${resumed.stderr}\n${resumed.stdout.slice(-400)}`);

    // 5) 证据断言
    const result = JSON.parse(fs.readFileSync(path.join(runsDir, runId, "result.json"), "utf-8")) as {
      agents: Array<{ label: string; replayed?: boolean; tokens?: number }>;
      result: string[];
    };
    const labels = result.agents.map((a) => `${a.label}${a.replayed ? "(replayed)" : ""}`);
    assert.deepEqual(
      result.agents.map((a) => a.label),
      ["n1", "n2", "n3"],
    );
    assert.equal(result.agents[0]?.replayed, true, "n1 应回放");
    assert.equal(result.agents[1]?.replayed, true, "n2 应回放");
    assert.equal(result.agents[2]?.replayed, undefined, "n3 应真实执行");
    assert.ok(!result.agents[0]?.tokens, "回放节点不产生新 token");
    assert.ok(result.agents[2]?.tokens, "n3 有 token 消耗");
    const journalLines = fs
      .readFileSync(path.join(runsDir, runId, "journal.jsonl"), "utf-8")
      .split("\n")
      .filter((l) => l.trim()).length;
    assert.equal(journalLines, 3, "journal 最终 3 条");
    const manifest = JSON.parse(fs.readFileSync(path.join(runsDir, runId, "manifest.json"), "utf-8")) as {
      status: string;
    };
    assert.equal(manifest.status, "completed");
    t.diagnostic(`节点标记：${labels.join(", ")}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
