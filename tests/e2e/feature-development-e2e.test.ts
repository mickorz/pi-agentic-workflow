/**
 * P3 e2e：真实功能开发闭环（V1 唯一最终验收案例，需真实模型凭证）
 *
 * 场景（执行文档 §1.3）：
 *  1. 隔离测试项目：add(a,b) 错误实现为 a-b，测试期望 a+b
 *  2. --non-interactive 首跑：分析→修复→测试→审查 后在 checkpoint 进入等待态（exit 3）
 *  3. resume 管道输入 y 批准 → 完成；项目 npm test 真实通过
 *  4. 证据：result.json（testsPass/approved）、事件 JSONL 完整、journal
 *  5. P3-05：另跑一次拒绝路径（n）→ CHECKPOINT_REJECTED，不得包装为成功
 *
 * 运行：PI_WORKFLOW_INTEGRATION=1 npm run test:e2e（需先 npm run build）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const explicit = process.env.PI_WORKFLOW_INTEGRATION === "1";
const CLI = path.resolve("dist/cli/index.js");
const REPO = process.cwd();

const PROJECT = {
  "package.json": JSON.stringify(
    { name: "broken-project", version: "1.0.0", type: "module", scripts: { test: "node --test test/" } },
    null,
    2,
  ),
  "src/math.js": "export function add(a, b) {\n  return a - b // BUG: should be a + b\n}\n",
  "test/math.test.js":
    'import { test } from "node:test"\nimport assert from "node:assert/strict"\nimport { add } from "../src/math.js"\n\ntest("add", () => {\n  assert.equal(add(2, 3), 5)\n})\n',
};

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, input?: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd });
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("P3-04：真实功能开发闭环（等待态 → 批准 → 完成）", { skip: !explicit ? "set PI_WORKFLOW_INTEGRATION=1 to run" : false }, async (t) => {
  assert.ok(fs.existsSync(CLI), "先 npm run build");
  const runtime = await ModelRuntime.create();
  const model = (await runtime.getAvailable())[0];
  if (!model) return t.skip("无可用模型凭证");
  const modelSpec = `${model.provider}/${model.id}`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-fd-"));
  for (const [file, content] of Object.entries(PROJECT)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  fs.copyFileSync(path.join(REPO, "examples/feature-development.js"), path.join(dir, "feature-development.js"));

  try {
    // 0) 前置：测试确实失败
    const preTest = await runCli(["validate", "feature-development.js"], dir);
    assert.equal(preTest.code, 0, "脚本合法");

    // 1) 非交互首跑 → checkpoint 等待态（exit 3）
    const first = await runCli(
      ["run", "feature-development.js", "--cwd", dir, "--model", modelSpec, "--non-interactive", "--json"],
      dir,
    );
    assert.equal(first.code, 3, `首跑应在 checkpoint 等待（exit 3），实际 ${first.code}\n${first.stderr.slice(-300)}`);
    const runId = fs.readdirSync(path.join(dir, ".pi-workflows", "runs"))[0]!;
    const manifest1 = JSON.parse(
      fs.readFileSync(path.join(dir, ".pi-workflows", "runs", runId, "manifest.json"), "utf-8"),
    ) as { status: string };
    assert.equal(manifest1.status, "waiting_checkpoint", "等待态持久化");

    // 2) 项目已被修复（general agent 在等待前已完成 implement 阶段）
    const fixed = fs.readFileSync(path.join(dir, "src/math.js"), "utf-8");
    assert.ok(!fixed.includes("a - b"), `math.js 应已修复：${fixed}`);

    // 3) resume 管道批准（y）→ 完成
    const resumed = await runCli(
      ["resume", runId, "--yes", "--model", modelSpec, "--json"],
      dir,
      "y\n",
    );
    assert.equal(resumed.code, 0, `批准后应完成：${resumed.stderr.slice(-300)}\n${resumed.stdout.slice(-200)}`);

    // 4) 终态证据
    const runsDir = path.join(dir, ".pi-workflows", "runs", runId);
    const manifest2 = JSON.parse(fs.readFileSync(path.join(runsDir, "manifest.json"), "utf-8")) as { status: string };
    assert.equal(manifest2.status, "completed");
    const result = JSON.parse(fs.readFileSync(path.join(runsDir, "result.json"), "utf-8")) as {
      result: { testsPass: boolean; approved: unknown };
      agents: Array<{ label: string; kind?: string; status: string }>;
    };
    assert.equal(result.result.testsPass, true, "check(commandSuccess npm test) 通过");
    assert.equal(result.result.approved, true, "checkpoint 批准");
    // 事件流完整（P3-01）：含 checkpoint.requested/resolved 且 sequence 连续
    const eventsFile = path.join(runsDir, "events.jsonl");
    assert.ok(fs.existsSync(eventsFile), "events.jsonl 存在");
    const events = fs
      .readFileSync(eventsFile, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { sequence: number; type: string });
    let expectedSeq = 1;
    for (const e of events) assert.equal(e.sequence, expectedSeq++, `sequence 连续：${e.sequence}`);
    assert.ok(events.some((e) => e.type === "checkpoint.requested"));
    assert.ok(events.some((e) => e.type === "checkpoint.resolved"));

    // 5) 项目测试真实通过（修复落地）
    const postTest = await new Promise<ExecResult>((resolve, reject) => {
      const child = spawn("npm", ["test"], { cwd: dir });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += String(d)));
      child.stderr.on("data", (d) => (stderr += String(d)));
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(postTest.code, 0, `修复后 npm test 应通过：\n${postTest.stdout.slice(-300)}`);
    t.diagnostic(`闭环完成：run=${runId}，agents=${result.agents.length}，events=${events.length}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("P3-05：人工拒绝不得包装为成功", { skip: !explicit ? "set PI_WORKFLOW_INTEGRATION=1 to run" : false }, async (t) => {
  assert.ok(fs.existsSync(CLI), "先 npm run build");
  const runtime = await ModelRuntime.create();
  const model = (await runtime.getAvailable())[0];
  if (!model) return t.skip("无可用模型凭证");
  const modelSpec = `${model.provider}/${model.id}`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-fd-reject-"));
  for (const [file, content] of Object.entries(PROJECT)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  fs.copyFileSync(path.join(REPO, "examples/feature-development.js"), path.join(dir, "feature-development.js"));
  try {
    const first = await runCli(
      ["run", "feature-development.js", "--cwd", dir, "--model", modelSpec, "--non-interactive", "--json"],
      dir,
    );
    assert.equal(first.code, 3);
    const runId = fs.readdirSync(path.join(dir, ".pi-workflows", "runs"))[0]!;
    // 拒绝（n）
    const rejected = await runCli(["resume", runId, "--yes", "--model", modelSpec], dir, "n\n");
    assert.notEqual(rejected.code, 0, "拒绝后不得成功");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, ".pi-workflows", "runs", runId, "manifest.json"), "utf-8"),
    ) as { status: string; error?: string };
    assert.equal(manifest.status, "failed");
    assert.match(manifest.error ?? "", /人工拒绝/);
    // 拒绝已记 journal：再次 resume 确定性重现拒绝（不重问）
    const reResumed = await runCli(["resume", runId, "--yes", "--model", modelSpec], dir, "y\n");
    assert.notEqual(reResumed.code, 0, "拒绝回放同样硬停（改 prompt 才会重问）");
    const manifest2 = JSON.parse(
      fs.readFileSync(path.join(dir, ".pi-workflows", "runs", runId, "manifest.json"), "utf-8"),
    ) as { status: string };
    assert.equal(manifest2.status, "failed");
    t.diagnostic("拒绝路径验证：failed + 回放确定性");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
