/** T1.0：command() 确定性子进程节点 —— 执行/捕获/超时/journal 回放/取消/参数安全 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runWorkflow } from "../../src/runtime/workflow-runtime.js";
import { makeRunner } from "../helpers/fake-runner.js";
import { WorkflowError, WorkflowErrorCode } from "../../src/runtime/errors.js";
import type { JournalEntry } from "../../src/runtime/types.js";

const echoRunner = () => makeRunner(async (p) => ({ type: "text" as const, value: `v:${p}`, sessionId: "s" }));

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "cmd-node-"));

const META = `export const meta = { name: "cmd_node" }`;

test("基本执行：stdout 回传 + exitCode 0 + 记录 kind=command", async () => {
  const { runner } = echoRunner();
  const result = await runWorkflow(
    `${META}
const r = await command({ executable: "node", args: ["-e", "console.log(JSON.stringify({ok:true}))"] })
return { parsed: JSON.parse(r.stdout), exitCode: r.exitCode }`,
    { agent: runner },
  );
  assert.equal((result.result as { parsed: { ok?: boolean } }).parsed.ok, true);
  assert.equal((result.result as { exitCode: number }).exitCode, 0);
  const rec = result.agents.find((a) => a.kind === "command");
  assert.ok(rec, "agents 列表应包含 kind=command 的记录");
  assert.equal(rec.status, "ok");
  assert.ok(rec.id && rec.durationMs !== undefined);
});

test("纯 command 脚本合法（无需 agent）", async () => {
  const result = await runWorkflow(
    `${META}
const r = await command({ executable: "node", args: ["-e", "process.stdout.write('hi')"] })
return r.stdout`,
    { agent: undefined as never },
  );
  assert.equal(result.result, "hi");
});

test("exitCode 非零正常 resolve（不抛错，脚本自行 check）", async () => {
  const { runner } = echoRunner();
  const result = await runWorkflow(
    `${META}
const r = await command({ executable: "node", args: ["-e", "console.error('boom'); process.exit(3)"] })
return { exitCode: r.exitCode, stderr: r.stderr.trim() }`,
    { agent: runner },
  );
  assert.equal((result.result as { exitCode: number }).exitCode, 3);
  assert.equal((result.result as { stderr: string }).stderr, "boom");
  const rec = result.agents.find((a) => a.kind === "command");
  assert.equal(rec?.status, "failed");
});

test("超时：SIGTERM 终止并抛 COMMAND_TIMEOUT（可恢复）", async () => {
  const { runner } = echoRunner();
  await assert.rejects(
    runWorkflow(
      `${META}
await command({ executable: "node", args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 500, label: "hang" })`,
      { agent: runner },
    ),
    (e: unknown) =>
      e instanceof WorkflowError && e.code === WorkflowErrorCode.COMMAND_TIMEOUT && e.recoverable === true,
  );
});

test("无法启动：COMMAND_SPAWN_FAILED（确定性错误）", async () => {
  const { runner } = echoRunner();
  await assert.rejects(
    runWorkflow(
      `${META}
await command({ executable: "definitely-not-exists-xyz", args: [] })`,
      { agent: runner },
    ),
    (e: unknown) =>
      e instanceof WorkflowError && e.code === WorkflowErrorCode.COMMAND_SPAWN_FAILED && e.recoverable === false,
  );
});

test("参数校验：非对象 / 缺 executable / args 非字符串数组 → SCRIPT_VALIDATION_ERROR", async () => {
  const { runner } = echoRunner();
  for (const spec of ["just-a-string", { args: ["a"] }, { executable: "node", args: [1, 2] }]) {
    await assert.rejects(
      runWorkflow(
        `${META}
await command(${JSON.stringify(spec)})`,
        { agent: runner },
      ),
      (e: unknown) => e instanceof WorkflowError && e.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
    );
  }
});

test("无 shell 注入面：args 中的元字符逐字传递", async () => {
  const { runner } = echoRunner();
  const result = await runWorkflow(
    `${META}
const r = await command({ executable: "node", args: ["-e", "process.stdout.write(process.argv[1])", "a;rm -rf / && echo pwned"] })
return r.stdout`,
    { agent: runner },
  );
  assert.equal(result.result, "a;rm -rf / && echo pwned");
});

test("journal 回放：成功结果写入 journal；resume 二次运行不重执行（副作用只发生一次）", async () => {
  const { runner } = echoRunner();
  const dir = tmpDir();
  const marker = path.join(dir, "marker.txt");
  const script = `${META}
const r = await command({ executable: "node", args: ["-e", "require('fs').appendFileSync(process.env.MARKER, 'x'); console.log('done')"], env: { MARKER: ${JSON.stringify(marker)} } })
return r.stdout.trim()`;

  const journal = new Map<string, JournalEntry & { key: string }>();
  const first = await runWorkflow(script, {
    agent: runner,
    runId: "replay-run",
    onAgentJournal: (e) => journal.set(e.key, e),
  });
  assert.equal(first.result, "done");
  assert.equal(fs.readFileSync(marker, "utf8"), "x");

  // 第二次：同 runId + resumeJournal → 命中回放，子进程不再执行（marker 仍只有一次）
  const second = await runWorkflow(script, {
    agent: runner,
    runId: "replay-run",
    resumeJournal: journal,
  });
  assert.equal(second.result, "done");
  assert.equal(fs.readFileSync(marker, "utf8"), "x");
  const rec = second.agents.find((a) => a.kind === "command");
  assert.equal(rec?.replayed, true, "第二次运行应标记 replayed");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("journal 失效：args 变更 → 哈希不匹配 → 重新执行", async () => {
  const { runner } = echoRunner();
  const dir = tmpDir();
  const marker = path.join(dir, "marker.txt");
  const mkScript = (v: string) => `${META}
const r = await command({ executable: "node", args: ["-e", "require('fs').appendFileSync(process.env.MARKER, 'x'); console.log(process.env.V)"], env: { MARKER: ${JSON.stringify(marker)}, V: ${JSON.stringify(v)} } })
return r.stdout.trim()`;

  const journal = new Map<string, JournalEntry & { key: string }>();
  await runWorkflow(mkScript("one"), { agent: runner, runId: "rerun", onAgentJournal: (e) => journal.set(e.key, e) });
  const second = await runWorkflow(mkScript("two"), { agent: runner, runId: "rerun", resumeJournal: journal });
  assert.equal(second.result, "two", "env 变更参与哈希身份，应重新执行");
  assert.equal(fs.readFileSync(marker, "utf8"), "xx");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("失败不写 journal：exit≠0 后 resume 重跑", async () => {
  const { runner } = echoRunner();
  const dir = tmpDir();
  const marker = path.join(dir, "marker.txt");
  const script = `${META}
const r = await command({ executable: "node", args: ["-e", "require('fs').appendFileSync(process.env.MARKER, 'x'); process.exit(2)"], env: { MARKER: ${JSON.stringify(marker)} } })
return r.exitCode`;

  const journal = new Map<string, JournalEntry & { key: string }>();
  const first = await runWorkflow(script, { agent: runner, runId: "fail-rerun", onAgentJournal: (e) => journal.set(e.key, e) });
  assert.equal(first.result, 2);
  assert.equal(journal.size, 0, "失败结果不进 journal");

  const second = await runWorkflow(script, { agent: runner, runId: "fail-rerun", resumeJournal: journal });
  assert.equal(second.result, 2);
  assert.equal(fs.readFileSync(marker, "utf8"), "xx", "resume 后重跑（副作用发生两次）");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("run 级中止：AbortController → 子进程被杀 + WORKFLOW_ABORTED", async () => {
  const { runner } = echoRunner();
  const controller = new AbortController();
  const pending = runWorkflow(
    `${META}
await command({ executable: "node", args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 60_000, label: "target" })`,
    { agent: runner, signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 300);
  await assert.rejects(
    pending,
    (e: unknown) => e instanceof WorkflowError && e.code === WorkflowErrorCode.WORKFLOW_ABORTED,
  );
});

test("输出截断：maxOutputBytes 超限置 truncated", async () => {
  const { runner } = echoRunner();
  const result = await runWorkflow(
    `${META}
const r = await command({ executable: "node", args: ["-e", "process.stdout.write('a'.repeat(10000))"], maxOutputBytes: 100 })
return { len: r.stdout.length, truncated: r.truncated }`,
    { agent: runner },
  );
  assert.equal((result.result as { len: number }).len, 100);
  assert.equal((result.result as { truncated: boolean }).truncated, true);
});

test("cwd 选项：相对 shared.cwd 解析", async () => {
  const { runner } = echoRunner();
  const dir = tmpDir();
  const result = await runWorkflow(
    `${META}
const r = await command({ executable: "node", args: ["-e", "process.stdout.write(process.cwd())"] })
return r.stdout`,
    { agent: runner, cwd: dir },
  );
  // macOS /var → /private/var 符号链接：子进程 cwd 为真实路径
  assert.equal(result.result, fs.realpathSync(dir));
  fs.rmSync(dir, { recursive: true, force: true });
});
