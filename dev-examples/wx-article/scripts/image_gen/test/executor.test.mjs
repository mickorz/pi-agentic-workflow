// 执行器测试矩阵（node --test，零费用）：A01–A08、A11、A13、A14 + validate 单元断言。
// A09（SIGKILL 中断恢复）与 A10（插图衔接）在独立 Python 套件 / 集成脚本中。
// 运行：node --test test/executor.test.mjs（在 image_gen/ 下）
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GEN = path.resolve(HERE, "..", "generate.mjs");
const TEST_PROVIDER = path.join(HERE, "helpers", "test-provider.mjs");

let workRoot;
const dirs = [];

function mkArticleDir(name, prompts) {
  const dir = path.join(workRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "image-prompts.json"), JSON.stringify(prompts, null, 2));
  dirs.push(dir);
  return dir;
}

function callsFile(dir) {
  return path.join(dir, ".calls.jsonl");
}
function faultFile(dir) {
  return path.join(dir, ".faults.json");
}

function runGen(dir, extraArgs = [], { env = {}, provider = TEST_PROVIDER } = {}) {
  const cf = callsFile(dir);
  const ff = faultFile(dir);
  fs.writeFileSync(cf, "");
  const res = spawnSync(
    process.execPath,
    [GEN, "--article-dir", dir, "--provider", provider, ...extraArgs],
    { encoding: "utf8", env: { ...process.env, ...env, TEST_CALLS_FILE: cf, TEST_FAULT_FILE: ff } },
  );
  return { res, calls: fs.readFileSync(cf, "utf8").trim() ? fs.readFileSync(cf, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [] };
}

function readManifest(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "image-manifest.json"), "utf8"));
}

function sha256(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

function lastLine(stdout, tag) {
  const lines = stdout.trim().split("\n").filter((l) => l.startsWith(tag));
  return lines.length ? lines[lines.length - 1].slice(tag.length) : null;
}

const SAMPLE = {
  version: 1,
  article_id: "ai-terms-04",
  style_prefix: "小王子童话插画风：柔和的水彩质感",
  items: [
    { id: "cover", kind: "cover", heading: "封面", prompt: "封面主视觉，AI 与童话星球", filename: "cover.png" },
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
      id: `term-${String(n).padStart(2, "0")}`,
      kind: "body",
      heading: `术语${n}`,
      prompt: `术语插图 ${n}：科技概念拟人化小场景`,
      filename: `0${n}-term.png`,
    })),
  ],
};

before(async () => {
  workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ig-test-"));
});

after(async () => {
  await fsp.rm(workRoot, { recursive: true, force: true }).catch(() => {});
});

test("validate: 基本单元断言（D6）", async () => {
  const { validatePrompts, isSafeImageFilename } = await import("../lib/validate.mjs");
  assert.equal(isSafeImageFilename("../evil.png"), false);
  assert.equal(isSafeImageFilename("/abs/path.png"), false);
  assert.equal(isSafeImageFilename("C:\\x.png"), false);
  assert.equal(isSafeImageFilename("CON.png"), false);
  assert.equal(isSafeImageFilename("a.png"), true);
  const bad = validatePrompts({ version: 2, article_id: "", items: [] });
  assert.equal(bad.ok, false);
  const dup = validatePrompts({ version: 1, article_id: "x", items: [
    { id: "a", kind: "body", prompt: "p", filename: "a.png" },
    { id: "a", kind: "body", prompt: "p", filename: "b.png" },
  ] });
  assert.match(dup.errors.join(""), /重复/);
});

test("A01 9 条批量（fake）：全成功 exit 0、文件/尺寸/manifest", () => {
  const dir = mkArticleDir("a01", SAMPLE);
  const { res, calls } = runGen(dir, ["--continue-on-error"]);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const result = JSON.parse(lastLine(res.stdout, "[RESULT] "));
  assert.equal(result.ok, true);
  assert.equal(result.succeeded, 9);
  assert.equal(result.failed, 0);
  assert.equal(calls.length, 9);
  // 封面 900×383，正文 1024×576
  const cover = fs.readFileSync(path.join(dir, "cover.png"));
  assert.equal(cover.readUInt32BE(16), 900);
  assert.equal(cover.readUInt32BE(20), 383);
  const body = fs.readFileSync(path.join(dir, "imgs", "01-term.png"));
  assert.equal(body.readUInt32BE(16), 1024);
  assert.equal(body.readUInt32BE(20), 576);
  const m = readManifest(dir);
  assert.equal(Object.values(m.entries).filter((e) => e.status === "succeeded").length, 9);
});

test("A02 重复运行零调用：PLAN 全 skip + 实跑零 provider 调用 + 文件字节不变", () => {
  const dir = mkArticleDir("a02", SAMPLE);
  runGen(dir);
  const before = sha256(path.join(dir, "imgs", "03-term.png"));
  const { res, calls } = runGen(dir, []);
  assert.equal(res.status, 0, res.stdout);
  assert.equal(calls.length, 0, "二次运行不应有 provider 调用");
  assert.equal(sha256(path.join(dir, "imgs", "03-term.png")), before);
  const plan = JSON.parse(lastLine(spawnGenPlan(dir), "[PLAN] "));
  assert.ok(plan.items.every((x) => x.action === "skip"));
});

function spawnGenPlan(dir) {
  const res = spawnSync(process.execPath, [GEN, "--article-dir", dir, "--provider", TEST_PROVIDER, "--dry-run"], {
    encoding: "utf8",
    env: { ...process.env, TEST_CALLS_FILE: callsFile(dir), TEST_FAULT_FILE: faultFile(dir) },
  });
  return res.stdout;
}

test("A03 第 6 张可恢复失败 ×(1+max_retries)：failed=1 其余成功 exit 1", () => {
  const dir = mkArticleDir("a03", SAMPLE);
  fs.writeFileSync(faultFile(dir), JSON.stringify({ "term-06": { failTimes: 3, code: "E_TIMEOUT", recoverable: true } }));
  const { res, calls } = runGen(dir, ["--continue-on-error"]);
  assert.equal(res.status, 1);
  const result = JSON.parse(lastLine(res.stdout, "[RESULT] "));
  assert.equal(result.ok, false);
  assert.equal(result.succeeded, 8);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.failed_ids, ["term-06"]);
  assert.equal(calls.filter((c) => c.id === "term-06").length, 3, "1+max_retries=3 次尝试");
  const m = readManifest(dir);
  assert.equal(m.entries["term-06"].status, "failed");
  assert.equal(m.entries["term-06"].error_code, "E_TIMEOUT");
  assert.equal(m.entries["term-06"].attempts, 3);
});

test("A04 续跑：仅 failed 条目被重新调用（--retry-failed）", () => {
  const dir = mkArticleDir("a04", SAMPLE);
  fs.writeFileSync(faultFile(dir), JSON.stringify({ "term-06": { failTimes: 3, code: "E_TIMEOUT", recoverable: true } }));
  runGen(dir, ["--continue-on-error"]);
  fs.writeFileSync(faultFile(dir), "{}");
  const { res, calls } = runGen(dir, ["--retry-failed", "--continue-on-error"]);
  assert.equal(res.status, 0, res.stdout);
  assert.deepEqual(calls.map((c) => c.id), ["term-06"], "只有 term-06 被调用");
  const result = JSON.parse(lastLine(res.stdout, "[RESULT] "));
  assert.equal(result.succeeded, 9);
});

test("A05 单图重做失败保原图：candidate failed、active 不变、无 bak", () => {
  const dir = mkArticleDir("a05", SAMPLE);
  runGen(dir);
  const active = path.join(dir, "imgs", "02-term.png");
  const hashBefore = sha256(active);
  fs.writeFileSync(faultFile(dir), JSON.stringify({ "term-02": { failTimes: 99, code: "E_TIMEOUT", recoverable: true } }));
  const { res, calls } = runGen(dir, ["--only-ids", "term-02", "--force-regenerate", "--continue-on-error"]);
  assert.equal(res.status, 1);
  assert.deepEqual(calls.map((c) => c.id).every((x) => x === "term-02"), true);
  assert.equal(calls.length, 3);
  // 原图与 active path 不变
  assert.equal(sha256(active), hashBefore);
  const m = readManifest(dir);
  const e = m.entries["term-02"];
  assert.equal(e.status, "stale");
  assert.equal(e.candidate.status, "candidate_failed");
  assert.equal(e.path, "imgs/02-term.png");
  // 无 bak 产生
  const baks = fs.readdirSync(path.join(dir, "imgs")).filter((f) => f.includes(".bak-"));
  assert.equal(baks.length, 0);
});

test("A06 输入变化失效：改 prompt → 仅该条目 candidate 重生成并自动提升，旧图进 bak", () => {
  const dir = mkArticleDir("a06", SAMPLE);
  runGen(dir);
  const old = path.join(dir, "imgs", "03-term.png");
  const hashBefore = sha256(old);
  // 改 prompt（模拟输入变更）
  const prompts = JSON.parse(fs.readFileSync(path.join(dir, "image-prompts.json"), "utf8"));
  prompts.items.find((it) => it.id === "term-03").prompt += "（新版）";
  fs.writeFileSync(path.join(dir, "image-prompts.json"), JSON.stringify(prompts));
  const { res, calls } = runGen(dir);
  assert.equal(res.status, 0, res.stdout);
  assert.deepEqual(calls.map((c) => c.id), ["term-03"]);
  const m = readManifest(dir);
  const e = m.entries["term-03"];
  assert.equal(e.status, "succeeded");
  assert.equal(e.candidate.status, "promoted");
  assert.equal(e.path, "imgs/03-term.png");
  // 新图内容变化、旧图进 bak-1
  assert.notEqual(sha256(old), hashBefore);
  const baks = fs.readdirSync(path.join(dir, "imgs")).filter((f) => f.startsWith("03-term.png.bak-"));
  assert.equal(baks.length, 1);
  assert.equal(sha256(path.join(dir, "imgs", baks[0])), hashBefore);
});

test("A07 路径逃逸：../x.png、绝对路径、保留名 → exit 2 且零写入", () => {
  const dir = mkArticleDir("a07", {
    version: 1,
    article_id: "x",
    style_prefix: "",
    items: [
      { id: "evil", kind: "body", prompt: "p", filename: "../evil.png" },
      { id: "abs", kind: "body", prompt: "p", filename: "/tmp/abs.png" },
      { id: "reserved", kind: "body", prompt: "p", filename: "CON.png" },
    ],
  });
  const { res } = runGen(dir);
  assert.equal(res.status, 2);
  assert.match(res.stdout, /\[FAIL\]/);
  assert.equal(fs.existsSync(path.join(dir, "image-manifest.json")), false, "无 manifest 落盘");
  assert.equal(fs.existsSync(path.join(dir, "imgs")), false);
});

test("A08 缺 key 快速失败：pi-image-gen 无 IMAGE_GEN_API_KEY → exit 2 [FAIL]", () => {
  const dir = mkArticleDir("a08", SAMPLE);
  const env = { ...process.env };
  delete env.IMAGE_GEN_API_KEY;
  delete env.IMAGE_GEN_BASE_URL;
  const res = spawnSync(process.execPath, [GEN, "--article-dir", dir, "--provider", "pi-image-gen"], {
    encoding: "utf8",
    env,
  });
  assert.equal(res.status, 2);
  assert.match(res.stdout, /\[FAIL\].*IMAGE_GEN_API_KEY/);
  assert.equal(fs.existsSync(path.join(dir, "image-manifest.json")), false, "无任何落盘");
});

test("A11 dry-run 零副作用：零文件写入、零 provider 调用", () => {
  const dir = mkArticleDir("a11", SAMPLE);
  const before = fs.readdirSync(dir).sort();
  const { res, calls } = runGen(dir, ["--dry-run"]);
  assert.equal(res.status, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(fs.readdirSync(dir).sort().filter((f) => !f.startsWith(".")), before, "目录无新文件");
  const plan = JSON.parse(lastLine(res.stdout, "[PLAN] "));
  assert.equal(plan.items.length, 9);
  assert.ok(plan.items.every((x) => x.action === "run-main"));
});

test("A13 损坏图拦截（verify-only 双向）：截断/删除/路径篡改 → ok:false", () => {
  const dir = mkArticleDir("a13", SAMPLE);
  runGen(dir);
  const img = path.join(dir, "imgs", "04-term.png");
  // 1) 截断
  fs.truncateSync(img, 100);
  let res = runGenVerify(dir);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /too-small/);
  // 2) 删除
  fs.unlinkSync(img);
  res = runGenVerify(dir);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /missing/);
  // 3) manifest 路径篡改（逃逸）
  fs.copyFileSync(path.join(dir, "imgs", "01-term.png"), img);
  const m = readManifest(dir);
  m.entries["term-04"].path = "../escape.png";
  fs.writeFileSync(path.join(dir, "image-manifest.json"), JSON.stringify(m));
  res = runGenVerify(dir);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /manifest-path-escape|missing/);
});

function runGenVerify(dir) {
  return spawnSync(process.execPath, [GEN, "--article-dir", dir, "--verify-only"], { encoding: "utf8" });
}

test("A14 并发拒绝：第二进程 [LOCKED] exit 3", async () => {
  const dir = mkArticleDir("a14", SAMPLE);
  fs.writeFileSync(faultFile(dir), "{}");
  const cf = callsFile(dir);
  const child1 = spawn(
    process.execPath,
    [GEN, "--article-dir", dir, "--provider", TEST_PROVIDER],
    { env: { ...process.env, TEST_CALLS_FILE: cf, TEST_FAULT_FILE: faultFile(dir), TEST_SLOW_MS: "700" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let out1 = "";
  child1.stdout.on("data", (d) => (out1 += d));
  // 等第一进程持锁（首个 IMG ok 或 400ms）
  await new Promise((r) => setTimeout(r, 400));
  const second = spawnSync(
    process.execPath,
    [GEN, "--article-dir", dir, "--provider", TEST_PROVIDER],
    { encoding: "utf8", env: { ...process.env, TEST_CALLS_FILE: cf + ".2", TEST_FAULT_FILE: faultFile(dir) } },
  );
  assert.equal(second.status, 3, `第二进程应 exit 3：${second.stdout}`);
  assert.match(second.stdout, /\[LOCKED\]/);
  const code = await new Promise((r) => child1.on("close", r));
  assert.equal(code, 0, `第一进程应正常完成：${out1}`);
});

test("A09-前置：遗留 running + 文件有效 → verify-recovered 零重生成", async () => {
  const dir = mkArticleDir("a09pre", { ...SAMPLE, items: SAMPLE.items.slice(0, 3) });
  // 正常生成后手工构造「死在成功写盘后、未写终态」状态
  runGen(dir);
  const m = readManifest(dir);
  const e = m.entries["term-02"];
  e.status = "running";
  fs.writeFileSync(path.join(dir, "image-manifest.json"), JSON.stringify(m));
  const { res, calls } = runGen(dir, ["--retry-failed"]);
  assert.equal(res.status, 0, res.stdout);
  assert.equal(calls.length, 0, "running+有效文件 → 恢复 succeeded，不重生成");
  const m2 = readManifest(dir);
  assert.equal(m2.entries["term-02"].status, "succeeded");
});

test("A09-前置2：遗留 running + 文件缺失 → 重跑该条目", () => {
  const dir = mkArticleDir("a09pre2", { ...SAMPLE, items: SAMPLE.items.slice(0, 3) });
  runGen(dir);
  fs.unlinkSync(path.join(dir, "imgs", "02-term.png"));
  const m = readManifest(dir);
  m.entries["term-02"].status = "running";
  fs.writeFileSync(path.join(dir, "image-manifest.json"), JSON.stringify(m));
  const { res, calls } = runGen(dir);
  assert.equal(res.status, 0, res.stdout);
  assert.deepEqual(calls.map((c) => c.id), ["term-02"]);
  assert.equal(fs.existsSync(path.join(dir, "imgs", "02-term.png")), true);
});

test("--promote：崩溃残留 ready 候选可手动提升", () => {
  const dir = mkArticleDir("promote", { ...SAMPLE, items: SAMPLE.items.slice(0, 2) });
  runGen(dir);
  const oldHash = sha256(path.join(dir, "imgs", "01-term.png"));
  // 手工构造 ready 候选（模拟：候选成功落盘后进程死于 ready 落盘与提升之间）
  const candPath = path.join(dir, "imgs", "01-term.cand-1.png");
  fs.copyFileSync(path.join(dir, "imgs", "01-term.png"), candPath);
  fs.writeFileSync(candPath, fs.readFileSync(candPath).subarray(0).map((b, i) => (i % 97 === 0 ? b ^ 0x20 : b))); // 内容微调
  const m = readManifest(dir);
  m.entries["term-01"].candidate = { status: "candidate_ready", path: "imgs/01-term.cand-1.png", prompt_hash: m.entries["term-01"].prompt_hash };
  fs.writeFileSync(path.join(dir, "image-manifest.json"), JSON.stringify(m));
  const { res } = runGen(dir, ["--promote", "term-01"]);
  assert.equal(res.status, 0, res.stdout);
  const m2 = readManifest(dir);
  assert.equal(m2.entries["term-01"].candidate.status, "promoted");
  assert.equal(m2.entries["term-01"].path, "imgs/01-term.png");
  assert.notEqual(sha256(path.join(dir, "imgs", "01-term.png")), oldHash);
  assert.equal(fs.existsSync(candPath), false, "候选文件已转正");
});
