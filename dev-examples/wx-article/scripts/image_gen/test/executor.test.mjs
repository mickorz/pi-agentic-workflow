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

function runGen(dir, extraArgs = [], { env = {}, provider = TEST_PROVIDER, gated = false } = {}) {
  const cf = callsFile(dir);
  const ff = faultFile(dir);
  fs.writeFileSync(cf, "");
  // gated=false：默认加 --no-require-style-approval 逃生口（旧用例测的是无门批量语义）；
  // 门禁行为由 P1.5 专项用例（gated / --mode batch）覆盖
  const gateArgs = gated ? [] : ["--no-require-style-approval"];
  const res = spawnSync(
    process.execPath,
    [GEN, "--article-dir", dir, "--provider", provider, ...gateArgs, ...extraArgs],
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
  const res = spawnSync(process.execPath, [GEN, "--article-dir", dir, "--provider", TEST_PROVIDER, "--no-require-style-approval", "--dry-run"], {
    encoding: "utf8",
    env: { ...process.env, TEST_CALLS_FILE: callsFile(dir), TEST_FAULT_FILE: faultFile(dir) },
  });
  return res.stdout;
}

test("A03 第 6 张可恢复失败 ×(1+重试)：failed=1 其余成功 exit 1", () => {
  // P1.5-D 后 E_TIMEOUT 属扣费不确定类（不重试）；限流类才是明确可恢复 → 用 E_RATE_LIMIT 验重试语义
  const dir = mkArticleDir("a03", SAMPLE);
  fs.writeFileSync(faultFile(dir), JSON.stringify({ "term-06": { failTimes: 3, code: "E_RATE_LIMIT", recoverable: true } }));
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
  assert.equal(m.entries["term-06"].error_code, "E_RATE_LIMIT");
  assert.equal(m.entries["term-06"].attempts, 3);
});

test("A04 续跑：仅 failed 条目被重新调用（--retry-failed）", () => {
  const dir = mkArticleDir("a04", SAMPLE);
  fs.writeFileSync(faultFile(dir), JSON.stringify({ "term-06": { failTimes: 3, code: "E_RATE_LIMIT", recoverable: true } }));
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
  fs.writeFileSync(faultFile(dir), JSON.stringify({ "term-02": { failTimes: 99, code: "E_RATE_LIMIT", recoverable: true } }));
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
    [GEN, "--article-dir", dir, "--provider", TEST_PROVIDER, "--no-require-style-approval"],
    { env: { ...process.env, TEST_CALLS_FILE: cf, TEST_FAULT_FILE: faultFile(dir), TEST_SLOW_MS: "700" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let out1 = "";
  child1.stdout.on("data", (d) => (out1 += d));
  // 等第一进程持锁（首个 IMG ok 或 400ms）
  await new Promise((r) => setTimeout(r, 400));
  const second = spawnSync(
    process.execPath,
    [GEN, "--article-dir", dir, "--provider", TEST_PROVIDER, "--no-require-style-approval"],
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

// 回归（T1.10 实测踩坑）：首次尝试可恢复失败、重试成功 → 条目终态必须 succeeded 且计入成功
test("A15 成功前置失败后 finally 不改写终态", () => {
  const dir = mkArticleDir("a15", SAMPLE);
  fs.writeFileSync(faultFile(dir), JSON.stringify({ "term-03": { failTimes: 1, code: "E_PROVIDER", recoverable: true } }));
  const { res } = runGen(dir, ["--continue-on-error"]);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const result = JSON.parse(lastLine(res.stdout, "[RESULT] "));
  assert.equal(result.ok, true);
  assert.equal(result.succeeded, 9);
  assert.equal(result.failed, 0);
  assert.equal(result.failed_ids.length, 0);
  const m = readManifest(dir);
  const e = m.entries["term-03"];
  assert.equal(e.status, "succeeded");
  assert.equal(e.error_code, null);
  assert.equal(e.attempts, 2);
});

// ═══ P1.5 验收用例（需求 V1.0 第八节）═══
const FAST = { IMAGE_GEN_INTER_DELAY_MS: "0" };

function runApprove(dir) {
  return runGen(dir, ["--approve-style"], { env: FAST });
}

function previewAndApprove(dir) {
  const pv = runGen(dir, ["--mode", "preview"], { gated: true, env: FAST });
  assert.equal(pv.res.status, 0, pv.res.stdout);
  const ap = runApprove(dir);
  assert.equal(ap.res.status, 0, ap.res.stdout);
  return JSON.parse(lastLine(ap.res.stdout, "[RESULT] "));
}

test("P15-1 验收1 preview：只发 1 次请求、只产 1 张图、绑定落 manifest；失败不重试", () => {
  const dir = mkArticleDir("p15-preview", SAMPLE);
  const { res, calls } = runGen(dir, ["--mode", "preview"], { gated: true, env: FAST });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const result = JSON.parse(lastLine(res.stdout, "[RESULT] "));
  assert.equal(result.mode, "preview");
  assert.equal(result.total, 1);
  assert.equal(result.succeeded, 1);
  assert.equal(calls.length, 1, "preview 只发 1 次 API 请求");
  assert.equal(calls[0].id, "term-01", "代表图 = 首个 body 条目");
  // 只产 1 张图：imgs 下仅 01-term.png，无封面
  assert.deepEqual(fs.readdirSync(path.join(dir, "imgs")), ["01-term.png"]);
  assert.equal(fs.existsSync(path.join(dir, "cover.png")), false);
  const sa = readManifest(dir).style_approval;
  assert.equal(sa.status, "preview_completed");
  assert.equal(sa.preview_image_id, "term-01");
  assert.ok(sa.fingerprint, "绑定指纹已落盘");
  assert.ok(sa.model_fingerprint);
  assert.equal(sa.preview_path, "imgs/01-term.png");

  // 失败也不重试（硬上限 1 次请求）
  const dir2 = mkArticleDir("p15-preview-fail", SAMPLE);
  fs.writeFileSync(faultFile(dir2), JSON.stringify({ "term-01": { failTimes: 1, code: "E_RATE_LIMIT", recoverable: true } }));
  const r2 = runGen(dir2, ["--mode", "preview", "--continue-on-error"], { gated: true, env: FAST });
  assert.equal(r2.res.status, 1);
  assert.equal(r2.calls.length, 1, "可恢复错误也不重试（preview 单次请求硬约束）");
  assert.equal(readManifest(dir2).entries["term-01"].status, "failed");
  assert.equal(readManifest(dir2).style_approval, undefined);
});

test("P15-2 验收2 提示词变更 → 审批失效回 pending，旧审批不得沿用", () => {
  const dir = mkArticleDir("p15-style-invalid", SAMPLE);
  previewAndApprove(dir);
  // 改全局风格提示词（评审场景：风格不满意 → 修改提示词）
  const prompts = JSON.parse(fs.readFileSync(path.join(dir, "image-prompts.json"), "utf8"));
  prompts.style_prefix += "（明亮的水彩风格）";
  fs.writeFileSync(path.join(dir, "image-prompts.json"), JSON.stringify(prompts));
  // 未重新 preview 直接 batch：拒绝，且审批自动回 pending
  const { res, calls } = runGen(dir, ["--mode", "batch"], { gated: true, env: FAST });
  assert.equal(res.status, 2);
  assert.match(res.stdout, /风格审批/);
  assert.match(res.stdout, /失效/);
  assert.equal(calls.length, 0);
  assert.equal(readManifest(dir).style_approval.status, "pending", "审批自动失效回 pending");
  // 拒绝已把审批物化回 pending，后续 approve-style 走「需先 preview」拒绝（不得沿用旧审批）
  const ap = runApprove(dir);
  assert.equal(ap.res.status, 2);
  assert.match(ap.res.stdout, /preview|已变更/);
});

test("P15-3 验收3 未审批直接 batch：拒绝并提示先完成风格审批", () => {
  const dir = mkArticleDir("p15-gate", SAMPLE);
  const { res, calls } = runGen(dir, ["--mode", "batch"], { gated: true, env: FAST });
  assert.equal(res.status, 2);
  assert.match(res.stdout, /需先 --mode preview/);
  assert.equal(calls.length, 0, "零 API 调用");
  // 无预览记录时 approve-style 同样拒绝
  const ap = runApprove(dir);
  assert.equal(ap.res.status, 2);
  assert.match(ap.res.stdout, /preview/);
});

test("P15-4 验收4 审批后 batch：付费授权由上层 checkpoint 把守，按 max-images-per-run 分批", () => {
  const dir = mkArticleDir("p15-cap", SAMPLE);
  const ap = previewAndApprove(dir);
  assert.equal(ap.approved, true);
  // 首跑：max-images-per-run=4 → 生成 4 张后停，剩余 pending
  const r1 = runGen(dir, ["--mode", "batch", "--max-images-per-run", "4"], { gated: true, env: FAST });
  assert.equal(r1.res.status, 1, r1.res.stdout);
  const s1 = JSON.parse(lastLine(r1.res.stdout, "[RESULT] "));
  assert.equal(s1.succeeded, 5, "preview 1 张 + 本轮 4 张");
  assert.equal(s1.capped_remaining, 4);
  assert.equal(s1.pending, 4);
  assert.equal(r1.calls.length, 4);
  // 续跑：审批仍有效（输入未变），补齐剩余
  const r2 = runGen(dir, ["--mode", "batch"], { gated: true, env: FAST });
  assert.equal(r2.res.status, 0, r2.res.stdout);
  const s2 = JSON.parse(lastLine(r2.res.stdout, "[RESULT] "));
  assert.equal(s2.succeeded, 9);
  assert.equal(s2.ok, true);
  assert.equal(r2.calls.length, 4, "只补剩余 4 张");
  // preview 复跑幂等：代表图已存在且哈希未变 → 零调用复用，绑定刷新
  const pv2 = runGen(dir, ["--mode", "preview"], { gated: true, env: FAST });
  assert.equal(pv2.res.status, 0, pv2.res.stdout);
  assert.equal(pv2.calls.length, 0);
  assert.equal(readManifest(dir).style_approval.status, "preview_completed");
});

test("P15-6 验收6 超时扣费不确定：单次尝试即停，整跑暂停转人工，--retry-unknown 显式解冻", () => {
  const dir = mkArticleDir("p15-unknown", SAMPLE);
  // E_TIMEOUT 即便 provider 标 recoverable 也属扣费不确定：禁自动重试
  fs.writeFileSync(faultFile(dir), JSON.stringify({ "term-03": { failTimes: 99, code: "E_TIMEOUT", recoverable: true } }));
  const r1 = runGen(dir, ["--continue-on-error"], { env: FAST });
  assert.equal(r1.res.status, 1, r1.res.stdout);
  const s1 = JSON.parse(lastLine(r1.res.stdout, "[RESULT] "));
  assert.equal(s1.paused_unknown, true);
  assert.deepEqual(s1.unknown_ids, ["term-03"]);
  assert.equal(r1.calls.filter((c) => c.id === "term-03").length, 1, "扣费不确定不重发");
  // 整跑暂停：cover/01/02 已成，03 unknown，04 之后未被调用
  assert.deepEqual(r1.calls.map((c) => c.id), ["cover", "term-01", "term-02", "term-03"]);
  const m1 = readManifest(dir);
  assert.equal(m1.entries["term-03"].status, "unknown");
  assert.equal(m1.entries["term-04"].status, "pending");
  // 缺 --retry-unknown 时默认只报告：零调用
  const r1b = runGen(dir, ["--continue-on-error"], { env: FAST });
  assert.equal(r1b.calls.filter((c) => c.id === "term-03").length, 0, "unknown 禁自动重试");
  // 人工显式解冻：故障清除后 --retry-unknown 补齐全部
  fs.writeFileSync(faultFile(dir), "{}");
  const r2 = runGen(dir, ["--retry-unknown", "--continue-on-error"], { env: FAST });
  assert.equal(r2.res.status, 0, r2.res.stdout);
  const s2 = JSON.parse(lastLine(r2.res.stdout, "[RESULT] "));
  assert.equal(s2.succeeded, 9);
  assert.equal(s2.unknown, 0);
});

test("P15-7 验收7 预算拦截：最坏估算超预算 → exit 2 且零请求；估算入 PLAN/RESULT", () => {
  const dir = mkArticleDir("p15-budget", SAMPLE);
  const { res, calls } = runGen(dir, ["--price-cny", "1", "--budget-cny", "5"], { env: FAST });
  assert.equal(res.status, 2, res.stdout);
  assert.match(res.stdout, /预算拦截/);
  assert.equal(calls.length, 0, "不发出任何请求");
  // 边界：预算恰等于最坏估算（9×1×3=27）→ 放行
  const ok = runGen(dir, ["--price-cny", "1", "--budget-cny", "27"], { env: FAST });
  assert.equal(ok.res.status, 0, ok.res.stdout);
  const s = JSON.parse(lastLine(ok.res.stdout, "[RESULT] "));
  assert.equal(s.cost.est_min_cny, 9);
  assert.equal(s.cost.est_max_cny, 27);
  // dry-run 计划携带估算
  const dir2 = mkArticleDir("p15-budget-plan", SAMPLE);
  const dr = runGen(dir2, ["--price-cny", "1", "--dry-run"], { env: FAST });
  const plan = JSON.parse(lastLine(dr.res.stdout, "[PLAN] "));
  assert.equal(plan.cost.est_max_cny, 27);
});

test("P16-1 provider 配置面：任何 OpenAI 兼容端点即插即用，路由确定性命中 custom provider", async () => {
  const { buildSettings, isZhipuEndpoint } = await import("../lib/providers/pi-image-gen.mjs");
  const { resolveModel } = await import("@amaster.ai/pi-image-gen");
  const cases = [
    { name: "智谱缺省", env: { IMAGE_GEN_API_KEY: "k1" }, baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
    { name: "OpenAI官方(内置id)", env: { IMAGE_GEN_API_KEY: "sk-x", IMAGE_GEN_BASE_URL: "https://api.openai.com/v1", IMAGE_GEN_MODEL: "gpt-image-1" }, baseUrl: "https://api.openai.com/v1" },
    { name: "自建网关", env: { IMAGE_GEN_API_KEY: "gw-x", IMAGE_GEN_BASE_URL: "https://my-gateway.example.com/v1", IMAGE_GEN_MODEL: "qwen-image-2.0" }, baseUrl: "https://my-gateway.example.com/v1" },
  ];
  for (const c of cases) {
    const cfg = buildSettings(c.env);
    assert.equal(cfg.baseUrl, c.baseUrl, c.name + " baseUrl");
    const r = resolveModel(cfg.modelId, cfg.settings);
    assert.ok(!r.error, c.name + " 路由失败: " + (r.error ?? ""));
    assert.equal(r.provider?.baseUrl, c.baseUrl, c.name + " 必须命中 custom provider（不被库内置 id 抢道）");
    assert.equal(r.remoteId, cfg.modelId, c.name + " remoteId");
  }
  assert.equal(isZhipuEndpoint("https://open.bigmodel.cn/api/paas/v4"), true);
  assert.equal(isZhipuEndpoint("https://api.openai.com/v1"), false);
  assert.equal(isZhipuEndpoint(undefined), false);
});

test("P16-2 OpenAI 兼容端点 wire 契约：本地 mock 验证 URL/Bearer/请求体/size 透传/b64 响应落盘", async () => {
  const http = await import("node:http");
  const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const captured = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      captured.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const provider = await import("../lib/providers/pi-image-gen.mjs");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ig-wire-"));
  dirs.push(tmp);
  const env0 = { ...process.env };
  try {
    process.env.IMAGE_GEN_API_KEY = "test-key-123";
    process.env.IMAGE_GEN_BASE_URL = "http://127.0.0.1:" + port;
    process.env.IMAGE_GEN_MODEL = "gpt-image-2";
    process.env.IMAGE_GEN_SIZE = "1536x1024";
    const r = await provider.generate({ prompt: "测试", outPath: path.join(tmp, "01-term.png"), context: { settings: provider.buildSettings() } });
    const req0 = captured[0];
    assert.equal(req0.url, "/v1/images/generations", "base 无路径自动补 /v1");
    assert.equal(req0.auth, "Bearer test-key-123");
    assert.equal(req0.body.model, "gpt-image-2");
    assert.equal(req0.body.n, 1);
    assert.equal(req0.body.size, "1536x1024", "IMAGE_GEN_SIZE 透传");
    assert.ok(fs.existsSync(r.path), "b64_json 响应解析落盘");
    // 未设置 size：不发送该字段（走端点缺省）
    delete process.env.IMAGE_GEN_SIZE;
    await provider.generate({ prompt: "测试2", outPath: path.join(tmp, "02-term.png"), context: { settings: provider.buildSettings() } });
    assert.equal(captured[1].body.size, undefined, "未设置 IMAGE_GEN_SIZE 不发送 size 字段");
  } finally {
    Object.assign(process.env, env0);
    server.close();
  }
});

test("P15-11 预算运行时门：累计请求数×单价超预算 → 发请求前停，提额后可续跑（跨运行累计）", () => {
  const dir = mkArticleDir("p15-budget-rt", SAMPLE);
  // 单次尝试 1、单价 1、预算 7、首轮 cap 4：
  // R1 est_max=4≤7 放行 → 4 张成功（累计 4 次）
  const r1 = runGen(dir, ["--max-attempts-per-image", "1", "--price-cny", "1", "--budget-cny", "7", "--max-images-per-run", "4"], { env: FAST });
  assert.equal(r1.res.status, 1, r1.res.stdout); // capped → pending>0 → exit 1
  let s = JSON.parse(lastLine(r1.res.stdout, "[RESULT] "));
  assert.equal(s.succeeded, 4);
  assert.equal(readManifest(dir).requests_issued, 4, "累计请求数持久化");
  // R2 est_max=5≤7 放行，但运行中第 8 次请求前 (7+1)×1=8>7 → budget-stopped：5,6,7 成功后停
  const r2 = runGen(dir, ["--max-attempts-per-image", "1", "--price-cny", "1", "--budget-cny", "7"], { env: FAST });
  assert.equal(r2.res.status, 1, r2.res.stdout);
  s = JSON.parse(lastLine(r2.res.stdout, "[RESULT] "));
  assert.equal(s.budget_stopped, true, "运行时预算门触发");
  assert.equal(s.succeeded, 7);
  assert.equal(s.pending, 2, "第 8、9 张留 pending");
  assert.equal(r2.calls.length, 3, "R2 只发了 3 次请求");
  assert.equal(s.requests_issued, 3);
  assert.equal(s.requests_issued_total, 7);
  assert.match(r2.res.stdout, /\[BUDGET\] stop/);
  // R3 提额到 9 → 补齐剩余 2 张，累计 9 次
  const r3 = runGen(dir, ["--max-attempts-per-image", "1", "--price-cny", "1", "--budget-cny", "9"], { env: FAST });
  assert.equal(r3.res.status, 0, r3.res.stdout);
  s = JSON.parse(lastLine(r3.res.stdout, "[RESULT] "));
  assert.equal(s.ok, true);
  assert.equal(s.succeeded, 9);
  assert.equal(s.requests_issued_total, 9);
});

test("P15-8 验收8 regenerate：单独重做走 candidate 链，原图隔离，旧图进 bak", () => {
  const dir = mkArticleDir("p15-regen", SAMPLE);
  runGen(dir, [], { env: FAST });
  // test-provider 是确定性 PNG（同 prompt 同字节）：用 variant 注入区分重做产物
  fs.writeFileSync(faultFile(dir), JSON.stringify({ "term-02": { variant: "-regen" } }));
  const oldHash = sha256(path.join(dir, "imgs", "02-term.png"));
  const { res, calls } = runGen(dir, ["--mode", "regenerate", "--only-ids", "term-02"], { env: FAST });
  assert.equal(res.status, 0, res.stdout);
  assert.deepEqual(calls.map((c) => c.id), ["term-02"], "只重做指定张");
  const e = readManifest(dir).entries["term-02"];
  assert.equal(e.status, "succeeded");
  assert.equal(e.candidate.status, "promoted");
  assert.notEqual(sha256(path.join(dir, "imgs", "02-term.png")), oldHash);
  assert.equal(fs.readdirSync(path.join(dir, "imgs")).filter((f) => f.startsWith("02-term.png.bak-")).length, 1);
});

// ════════ P1.6 IU 系列：image-use provider（fake CLI 注入，方案 V3）════════
const FAKE_IU_CLI = path.join(HERE, "helpers", "fake-image-use.mjs");
const IU_ENV_BASE = { IMAGE_USE_PYTHON: process.execPath, IMAGE_USE_SCRIPT: FAKE_IU_CLI, IMAGE_GEN_INTER_DELAY_MS: "0" };
function iuEnv(mode, extra = {}) {
  return { ...IU_ENV_BASE, ...(mode ? { FAKE_MODE: mode } : {}), FAKE_CALLS_FILE: path.join(workRoot, `iu-calls-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jsonl`), ...extra };
}
function iuCalls(env) {
  const p = env.FAKE_CALLS_FILE;
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

test("IU-1 classifyFailure 决策树全行（含中断三态与 URL 不泄漏）", async () => {
  const { classifyFailure } = await import("../lib/providers/image-use.mjs");
  // 1 ENOENT（区分解释器/脚本）
  let c = classifyFailure({ spawnError: { message: "spawn python ENOENT" } });
  assert.equal(c.code, "E_NO_PYTHON"); assert.equal(c.recoverable, false); assert.equal(c.uncertain, false);
  c = classifyFailure({ spawnError: { message: "spawn node /x/fake ENOENT" } });
  assert.equal(c.code, "E_NO_SCRIPT");
  // 4 already submitted（含 URL 的 stderr 不得把 URL 带进 summary）
  c = classifyFailure({ exitCode: 1, stderr: "timed out after 300s waiting to confirm the image\nThe prompt was already submitted; check the conversation before retrying: https://chatgpt.com/c/xyz" });
  assert.equal(c.code, "E_TIMEOUT"); assert.equal(c.uncertain, true); assert.equal(c.recoverable, false);
  assert.ok(!c.summary.includes("chatgpt.com"), "summary 不含会话 URL");
  c = classifyFailure({ exitCode: 1, stderr: "chatgpt.com rate-limited this account ... The prompt was already submitted" });
  assert.equal(c.code, "E_RATELIMIT_SUBMITTED"); assert.equal(c.uncertain, true);
  // 5 未提交特征族
  c = classifyFailure({ exitCode: 1, stderr: "chrome-use timed out: open" });
  assert.equal(c.code, "E_ENV"); assert.equal(c.uncertain, false);
  c = classifyFailure({ exitCode: 1, stderr: "chatgpt.com rate-limited this account ('Too many requests') — the page surface temporarily blocked" });
  assert.equal(c.code, "E_RATE_LIMIT"); assert.equal(c.uncertain, false);
  c = classifyFailure({ exitCode: 1, stderr: "ChatGPT reported an image-generation limit. reset in 4h" });
  assert.equal(c.code, "E_QUOTA");
  c = classifyFailure({ exitCode: 1, stderr: "browser is not logged in to chatgpt.com; please sign in" });
  assert.equal(c.code, "E_LOGIN");
  // 6/6b 外部中断按提交标记分流
  c = classifyFailure({ exitCode: null, stderr: "[  3.1s] opening ChatGPT via relay", externalAbort: true });
  assert.equal(c.code, "E_ABORTED"); assert.equal(c.recoverable, true); assert.equal(c.uncertain, false);
  c = classifyFailure({ exitCode: null, stderr: "[  8.2s] pasting prompt\n[  8.5s] prompt submitted once", externalAbort: true });
  assert.equal(c.code, "E_ABORTED"); assert.equal(c.uncertain, true); assert.equal(c.recoverable, false);
  c = classifyFailure({ exitCode: null, stderr: "[  8.2s] verified prompt (12 characters) and 0 reference image(s)", externalAbort: true });
  assert.equal(c.uncertain, true, "发送窗口标记也视为可能已提交");
  // 7/8 自超时/crash 按标记分流
  c = classifyFailure({ exitCode: null, stderr: "[  8.5s] prompt submitted once", selfTimeout: true });
  assert.equal(c.code, "E_TIMEOUT"); assert.equal(c.uncertain, true);
  c = classifyFailure({ exitCode: null, stderr: "[  3.1s] opening ChatGPT via relay", selfTimeout: true });
  assert.equal(c.code, "E_TIMEOUT"); assert.equal(c.uncertain, false); assert.equal(c.recoverable, false, "未提交超时也不自动重试");
  c = classifyFailure({ exitCode: 3, stderr: "weird internal crash" });
  assert.equal(c.code, "E_CRASH"); assert.equal(c.uncertain, false);
  c = classifyFailure({ exitCode: 3, stderr: "[  8.5s] prompt submitted once\nboom" });
  assert.equal(c.code, "E_CRASH"); assert.equal(c.uncertain, true);
});

test("IU-2 buildArgs 参数拼装与小 deadline 负数防护", async () => {
  const { buildArgs } = await import("../lib/providers/image-use.mjs");
  const a = buildArgs({ prompt: "一只猫", outPath: "/tmp/x.png", size: "1536x1024", reference: "/tmp/ref.png" });
  assert.deepEqual(a, ["--backend", "web", "--quiet", "一只猫", "-o", "/tmp/x.png", "--size", "1536x1024", "--style-ref", "/tmp/ref.png", "--timeout", "325"]);
  // 小 deadline：不传非法 --timeout（V3 细节修 1）
  const b = buildArgs({ prompt: "p", outPath: "/tmp/x.png", deadlineMs: 300 });
  assert.ok(!b.includes("--timeout"), "300ms deadline 不产生负 timeout flag");
  const d = buildArgs({ prompt: "p", outPath: "/tmp/x.png", deadlineMs: 34_000 });
  assert.ok(!d.includes("--timeout"), "34000ms 得 29s 低于最小安全值 30s 时不传");
  const e = buildArgs({ prompt: "p", outPath: "/tmp/x.png", deadlineMs: 40_000 });
  assert.equal(e[e.indexOf("--timeout") + 1], "35");
});

test("IU-3 generate 正常路径：文件落盘、路径一致、返回契约", async () => {
  const mod = await import("../lib/providers/image-use.mjs");
  const out = path.join(workRoot, "iu3", "imgs", "01.png");
  const r = await mod.generate({
    kind: "body", prompt: "测试图", outPath: out,
    context: { settings: { pythonBin: process.execPath, script: FAKE_IU_CLI } },
  });
  assert.equal(path.resolve(r.path), path.resolve(out), "路径契约：stdout 路径必须等于 outPath");
  assert.equal(r.provider, "image-use"); assert.equal(r.model, "web");
  assert.equal(r.mime, "image/png"); assert.ok(r.bytes > 0);
  assert.ok(fs.existsSync(out));
});

test("IU-4 generate uncertain 路径：err.uncertain 且消息不含 URL", async () => {
  const mod = await import("../lib/providers/image-use.mjs");
  const prev = process.env.FAKE_MODE;
  process.env.FAKE_MODE = "uncertain";
  try {
    await assert.rejects(
      mod.generate({ kind: "body", prompt: "p", outPath: path.join(workRoot, "iu4.png"), context: { settings: { pythonBin: process.execPath, script: FAKE_IU_CLI } } }),
      (e) => e.uncertain === true && e.code === "E_TIMEOUT" && !String(e.message).includes("chatgpt.com/c"),
    );
  } finally {
    if (prev === undefined) delete process.env.FAKE_MODE; else process.env.FAKE_MODE = prev;
  }
});

test("IU-5 执行器级 preview（image-use + fake CLI）：IMG ok + 风格绑定 preview_completed", () => {
  const dir = mkArticleDir("iu5-preview", SAMPLE);
  const env = iuEnv(null);
  const { res } = runGen(dir, ["--mode", "preview", "--provider", "image-use"], { env, provider: "image-use" });
  assert.equal(res.status, 0, res.stdout);
  assert.match(res.stdout, /\[IMG ok\] term-01 attempts=1/);
  const m = readManifest(dir);
  assert.equal(m.style_approval.status, "preview_completed");
  assert.equal(m.style_approval.model_fingerprint, "image-use:web");
});

test("IU-6 执行器级 batch 撞 uncertain：unknown + paused_unknown + 零自动重试", () => {
  const dir = mkArticleDir("iu6-unknown", SAMPLE);
  const env = iuEnv("uncertain");
  const { res } = runGen(dir, ["--provider", "image-use", "--only-ids", "term-01"], { env, provider: "image-use" });
  assert.equal(res.status, 1, res.stdout);
  const s = JSON.parse(lastLine(res.stdout, "[RESULT] "));
  assert.equal(s.unknown, 1); assert.equal(s.unknown_ids[0], "term-01"); assert.equal(s.paused_unknown, true);
  assert.equal(readManifest(dir).entries["term-01"].status, "unknown");
  assert.equal(iuCalls(env).length, 1, "单次尝试即停，无误重试");
});

test("IU-7a 提交前外部中断：E_ABORTED 可恢复（pending 语义前提）", async () => {
  const mod = await import("../lib/providers/image-use.mjs");
  const ac = new AbortController();
  const prev = process.env.FAKE_MODE;
  process.env.FAKE_MODE = "sleep-pre";
  const p = mod.generate({ kind: "body", prompt: "p", outPath: path.join(workRoot, "iu7a.png"), signal: ac.signal, context: { settings: { pythonBin: process.execPath, script: FAKE_IU_CLI } } });
  setTimeout(() => ac.abort(), 400);
  try {
    await assert.rejects(p, (e) => e.code === "E_ABORTED" && e.recoverable === true && e.uncertain === false);
  } finally {
    if (prev === undefined) delete process.env.FAKE_MODE; else process.env.FAKE_MODE = prev;
  }
});

test("IU-7b 提交后外部中断：E_ABORTED + uncertain → unknown 语义（禁自动重发）", async () => {
  const mod = await import("../lib/providers/image-use.mjs");
  const ac = new AbortController();
  const prev = process.env.FAKE_MODE;
  process.env.FAKE_MODE = "sleep-post";
  const p = mod.generate({ kind: "body", prompt: "p", outPath: path.join(workRoot, "iu7b.png"), signal: ac.signal, context: { settings: { pythonBin: process.execPath, script: FAKE_IU_CLI } } });
  setTimeout(() => ac.abort(), 400);
  try {
    await assert.rejects(p, (e) => e.code === "E_ABORTED" && e.uncertain === true && e.recoverable === false);
  } finally {
    if (prev === undefined) delete process.env.FAKE_MODE; else process.env.FAKE_MODE = prev;
  }
});

test("IU-7c 执行器级 SIGINT 提交后中断：条目进 unknown（真进程信号，POSIX only）", { skip: process.platform === "win32" ? "Windows 无 SIGINT 语义（同 A09 处理，见 dev-docs/experience/windows-signal-semantics-stop.md）" : false }, async () => {
  const dir = mkArticleDir("iu7c-sigint", SAMPLE);
  const env = iuEnv("sleep-post");
  const child = spawn(process.execPath, [GEN, "--article-dir", dir, "--provider", "image-use", "--no-require-style-approval", "--only-ids", "term-01"], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  await new Promise((r) => setTimeout(r, 1500)); // 等 fake CLI 打出提交标记并进入长睡
  child.kill("SIGINT");
  const code = await new Promise((r) => child.on("close", r));
  assert.equal(code, 130, `exit 130（中断）：${out}`);
  const e = readManifest(dir).entries["term-01"];
  assert.equal(e.status, "unknown", "提交后中断 → unknown 禁自动重发（V3 P0-1）");
  assert.equal(e.error_code, "E_ABORTED");
  assert.equal(iuCalls(env).length, 1);
});

test("IU-8 自超时（极小 deadline）：不传负 timeout，E_TIMEOUT uncertain → unknown", () => {
  const dir = mkArticleDir("iu8-selftimeout", SAMPLE);
  const env = iuEnv("sleep-post", { IMAGE_USE_TIMEOUT_MS: "1500" });
  const { res } = runGen(dir, ["--provider", "image-use", "--only-ids", "term-01"], { env, provider: "image-use" });
  assert.equal(res.status, 1, res.stdout);
  assert.match(res.stdout, /\[IMG fail\] term-01 attempts=1 code=E_TIMEOUT \(uncertain:扣费不确定\)/);
  assert.equal(readManifest(dir).entries["term-01"].status, "unknown");
  assert.equal(iuCalls(env).length, 1, "自超时单次即停");
});

test("IU-9 crash 兜底：无提交标记 → 不重试停跑（failed，可人工重跑）", () => {
  const dir = mkArticleDir("iu9-crash", SAMPLE);
  const env = iuEnv("crash");
  const { res } = runGen(dir, ["--provider", "image-use", "--only-ids", "term-01"], { env, provider: "image-use" });
  assert.equal(res.status, 1, res.stdout);
  assert.match(res.stdout, /\[IMG fail\] term-01 attempts=1 code=E_CRASH/);
  assert.equal(readManifest(dir).entries["term-01"].status, "failed");
  assert.equal(iuCalls(env).length, 1);
});

test("IU-10 路径越界拒绝：stdout 路径与 outPath 不一致 → E_BAD_OUTPUT", async () => {
  const mod = await import("../lib/providers/image-use.mjs");
  const prev = process.env.FAKE_MODE;
  process.env.FAKE_MODE = "path-mismatch";
  const out = path.join(workRoot, "iu10", "imgs", "01.png");
  try {
    await assert.rejects(
      mod.generate({ kind: "body", prompt: "p", outPath: out, context: { settings: { pythonBin: process.execPath, script: FAKE_IU_CLI } } }),
      (e) => e.code === "E_BAD_OUTPUT",
    );
    assert.ok(!fs.existsSync(out), "规范路径不落盘");
    const stray = out.replace(/(\.[a-z0-9]+)$/i, ".stray$1");
    assert.ok(fs.existsSync(stray), "旁路文件由 fake CLI 制造（provider 侧只拒绝不清理）");
    fs.rmSync(stray, { force: true });
  } finally {
    if (prev === undefined) delete process.env.FAKE_MODE; else process.env.FAKE_MODE = prev;
  }
});

// ── --resolve-unknown 系列（IU-11/12）──
function mkUnknownManifest(name) {
  const dir = mkArticleDir(name, SAMPLE);
  const m = {
    version: 1, article_id: SAMPLE.article_id, requests_issued: 1,
    style_approval: { status: "none" },
    entries: {
      "term-01": {
        id: "term-01", kind: "body", filename: "01-term.png", prompt_hash: "x",
        status: "unknown", error_code: "E_TIMEOUT", attempts: 1, path: null,
        model_fingerprint: "image-use:web", reference_hash: null, candidate: null,
      },
    },
  };
  fs.writeFileSync(path.join(dir, "image-manifest.json"), JSON.stringify(m, null, 2));
  return dir;
}

test("IU-11 --resolve-unknown 正常与拒绝路径", async () => {
  const { encodePng } = await import("../lib/providers/fake.mjs");
  // 正常：CLI 子进程
  const dir = mkUnknownManifest("iu11-ok");
  const src = path.join(workRoot, "iu11-src.png");
  fs.writeFileSync(src, encodePng(32, 24, "resolve-src"));
  const res = spawnSync(process.execPath, [GEN, "--article-dir", dir, "--resolve-unknown", "term-01", "--from", src], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stdout);
  const m = readManifest(dir);
  assert.equal(m.entries["term-01"].status, "succeeded");
  assert.ok(fs.existsSync(path.join(dir, "imgs", "01-term.png")), "文件到规范路径");
  assert.match(res.stdout, /\[RESULT\].*"resolved":"term-01"/);
  // 拒绝：非 unknown 条目（已 succeeded）
  const res2 = spawnSync(process.execPath, [GEN, "--article-dir", dir, "--resolve-unknown", "term-01", "--from", src], { encoding: "utf8" });
  assert.equal(res2.status, 2); assert.match(res2.stdout, /\[FAIL\].*需为 unknown/);
  // 拒绝：未知 id
  const res3 = spawnSync(process.execPath, [GEN, "--article-dir", dir, "--resolve-unknown", "nope", "--from", src], { encoding: "utf8" });
  assert.equal(res3.status, 2); assert.match(res3.stdout, /\[FAIL\].*未知 id/);
  // 拒绝：缺 --from
  const res4 = spawnSync(process.execPath, [GEN, "--article-dir", dir, "--resolve-unknown", "term-01"], { encoding: "utf8" });
  assert.equal(res4.status, 2); assert.match(res4.stdout, /\[FAIL\].*--from/);
});

test("IU-12a 源图核验失败：零状态变化、临时文件清理", () => {
  const dir = mkUnknownManifest("iu12a-badsrc");
  const src = path.join(workRoot, "iu12a-corrupt.png");
  fs.writeFileSync(src, "not an image at all");
  const res = spawnSync(process.execPath, [GEN, "--article-dir", dir, "--resolve-unknown", "term-01", "--from", src], { encoding: "utf8" });
  assert.equal(res.status, 2); assert.match(res.stdout, /\[FAIL\].*核验失败/);
  const m = readManifest(dir);
  assert.equal(m.entries["term-01"].status, "unknown", "manifest 不变");
  assert.ok(!fs.existsSync(path.join(dir, "imgs", "01-term.png")), "目标未落盘");
  assert.deepEqual(fs.readdirSync(path.join(dir, "imgs")), [], "临时文件已清理");
});

test("IU-12b saveManifest 失败注入：不报成功 + 重入幂等收敛（无新 bak）", async () => {
  const { runResolveUnknown } = await import("../generate.mjs");
  const { encodePng } = await import("../lib/providers/fake.mjs");
  const dir = mkUnknownManifest("iu12b-savfail");
  const src = path.join(workRoot, "iu12b-src.png");
  fs.writeFileSync(src, encodePng(32, 24, "resolve-src"));
  const args = { resolveUnknown: "term-01", resolveFrom: src };
  // 注入 saveManifest 失败 + 拦截 process.exit（fail() 内部调用）
  const origExit = process.exit;
  let exitCode = null;
  process.exit = (c) => { exitCode = c; throw new Error(`__EXIT_${c}__`); };
  try {
    await assert.rejects(
      runResolveUnknown(args, { articleDir: dir, manifestPath: path.join(dir, "image-manifest.json") }, { saveManifest: async () => { throw new Error("injected save failure"); } }),
      (e) => /__EXIT_2__/.test(e.message),
    );
  } finally {
    process.exit = origExit;
  }
  assert.equal(exitCode, 2, "落盘失败 exit 2 不报成功");
  assert.ok(fs.existsSync(path.join(dir, "imgs", "01-term.png")), "目标文件已就位（可恢复证据）");
  assert.equal(readManifest(dir).entries["term-01"].status, "unknown", "manifest 仍 unknown");
  // 重入（真实 saveManifest）：幂等快路径收敛，无第二条 bak 链
  const bakCount = (d) => fs.readdirSync(path.join(d, "imgs")).filter((f) => f.includes(".bak-")).length;
  assert.equal(bakCount(dir), 0, "首程未产生 bak（目标原本不存在）");
  const origLog = console.log;
  let captured = "";
  console.log = (s) => { captured += s; };
  process.exit = (c) => { exitCode = c; throw new Error(`__EXIT_${c}__`); };
  try {
    await assert.rejects(runResolveUnknown(args, { articleDir: dir, manifestPath: path.join(dir, "image-manifest.json") }), /__EXIT_0__/);
  } finally {
    console.log = origLog;
    process.exit = origExit;
  }
  assert.match(captured, /\[RESULT\].*"resolved":"term-01"/);
  assert.equal(readManifest(dir).entries["term-01"].status, "succeeded");
  assert.equal(bakCount(dir), 0, "重入走幂等快路径，bak 不增长");
});

test("IU-12c 目标已存在且同内容：幂等快路径，不产生 bak", async () => {
  const { runResolveUnknown } = await import("../generate.mjs");
  const { encodePng } = await import("../lib/providers/fake.mjs");
  const dir = mkUnknownManifest("iu12c-idem");
  const src = path.join(workRoot, "iu12c-src.png");
  fs.writeFileSync(src, encodePng(32, 24, "resolve-src"));
  // 崩溃现场模拟：目标已在位（与源同内容）、manifest 仍 unknown
  fs.mkdirSync(path.join(dir, "imgs"), { recursive: true });
  fs.copyFileSync(src, path.join(dir, "imgs", "01-term.png"));
  const args = { resolveUnknown: "term-01", resolveFrom: src };
  const origLog = console.log; const origExit = process.exit;
  let captured = "";
  console.log = (s) => { captured += s; };
  process.exit = (c) => { throw new Error(`__EXIT_${c}__`); };
  try {
    await assert.rejects(runResolveUnknown(args, { articleDir: dir, manifestPath: path.join(dir, "image-manifest.json") }), /__EXIT_0__/);
  } finally {
    console.log = origLog; process.exit = origExit;
  }
  assert.match(captured, /"resolved":"term-01"/);
  assert.equal(fs.readdirSync(path.join(dir, "imgs")).filter((f) => f.includes(".bak-")).length, 0, "同内容跳过备份");
  assert.equal(readManifest(dir).entries["term-01"].status, "succeeded");
});

test("IU-12d 目标已存在且内容不同：旧图 bak 后原子替换", async () => {
  const { runResolveUnknown } = await import("../generate.mjs");
  const { encodePng } = await import("../lib/providers/fake.mjs");
  const dir = mkUnknownManifest("iu12d-replace");
  const src = path.join(workRoot, "iu12d-src.png");
  fs.writeFileSync(src, encodePng(32, 24, "resolve-src"));
  fs.mkdirSync(path.join(dir, "imgs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "imgs", "01-term.png"), encodePng(32, 24, "different-old")); // 旧图（内容不同）
  const args = { resolveUnknown: "term-01", resolveFrom: src };
  const origLog = console.log; const origExit = process.exit;
  let captured = "";
  console.log = (s) => { captured += s; };
  process.exit = (c) => { throw new Error(`__EXIT_${c}__`); };
  try {
    await assert.rejects(runResolveUnknown(args, { articleDir: dir, manifestPath: path.join(dir, "image-manifest.json") }), /__EXIT_0__/);
  } finally {
    console.log = origLog; process.exit = origExit;
  }
  const m = readManifest(dir);
  assert.equal(m.entries["term-01"].status, "succeeded");
  assert.equal(m.entries["term-01"].previous_path, "imgs/01-term.png.bak-1", "旧图进 bak");
  assert.equal(sha256(path.join(dir, "imgs", "01-term.png")), sha256(src), "新图原子替换到位");
});

// Gate A 断言集：原用例零回归由整套运行保证；无误重试/无越界写入在 IU-6/8/10/12 内联断言。

test("IU-13 候选链提升后回写 prompt_hash：改风格重 preview 后二次 batch 零重复生成（T6 真实验收发现）", () => {
  const dir = mkArticleDir("iu13-cand-hash", SAMPLE);
  // 首轮批量（无门）：全部成功
  let r = runGen(dir, [], { env: FAST });
  assert.equal(r.res.status, 0, r.res.stdout);
  // 改 style_prefix（等效改风格）→ 全部条目 inputChanged → stale → 候选链
  const promptsPath = path.join(dir, "image-prompts.json");
  const prompts = JSON.parse(fs.readFileSync(promptsPath, "utf8"));
  prompts.style_prefix = "新风格：手绘黑白线稿";
  fs.writeFileSync(promptsPath, JSON.stringify(prompts, null, 2));
  // 风格门内重 preview（代表条目走候选链提升）
  r = runGen(dir, ["--mode", "preview"], { env: FAST, gated: true });
  assert.equal(r.res.status, 0, r.res.stdout);
  const m1 = readManifest(dir);
  const repId = m1.style_approval.preview_image_id;
  // 修复点：候选链提升后 entry.prompt_hash 必须已回写为当前输入哈希
  const repPrompt = prompts.items.find((it) => it.id === repId).prompt;
  const expectedHash = crypto.createHash("sha256").update(prompts.style_prefix + "\n---\n" + repPrompt).digest("hex");
  assert.equal(m1.entries[repId].prompt_hash, expectedHash, "提升后哈希已回写（promptHash = sha256(style_prefix+\\n---\\n+prompt)）");
  // 批量补齐剩余条目
  runGen(dir, ["--approve-style"], { env: FAST });
  r = runGen(dir, [], { env: FAST });
  assert.equal(r.res.status, 0, r.res.stdout);
  // 关键断言：再次 batch（输入未变）应全 skip 零调用——修复前代表条目会因旧哈希被永久重生成
  const callsBefore = fs.readFileSync(callsFile(dir), "utf8").trim();
  fs.writeFileSync(callsFile(dir), "");
  r = runGen(dir, [], { env: FAST });
  assert.equal(r.res.status, 0, r.res.stdout);
  const newCalls = fs.readFileSync(callsFile(dir), "utf8").trim();
  assert.equal(newCalls, "", `输入未变的二次 batch 必须零请求（实际调用：${newCalls}）`);
  void callsBefore;
});

test("IU-14 backend 校验与模型指纹（T6：死代码修复 + 切 backend 不复用旧条目）", async () => {
  const { buildSettings } = await import("../lib/providers/image-use.mjs");
  // 1 非法 backend：修复前校验在 return 之后不可达，现在 buildSettings 即抛错
  assert.throws(() => buildSettings({ IMAGE_USE_BACKEND: "agy" }), /IMAGE_USE_BACKEND 非法/);
  // 2 合法值：effectiveModel 跟随 backend（模型指纹消费源）
  assert.equal(buildSettings({}).backend, "web");
  assert.equal(buildSettings({}).effectiveModel, "web");
  assert.equal(buildSettings({ IMAGE_USE_BACKEND: "codex" }).effectiveModel, "codex");

  // 3 执行器级：web 跑成 → 切 codex 后指纹变化 → 旧条目判 stale 重生成，不复用
  //    （--only-ids 单条：fake CLI 出图 64×48 约 857B，个别条目低于 verify 的 1024B 阈值，与既有 IU 系列一致避开全量）
  const dir = mkArticleDir("iu14-backend-fp", SAMPLE);
  let env = iuEnv(null);
  let r = runGen(dir, ["--only-ids", "term-01"], { env, provider: "image-use" });
  assert.equal(r.res.status, 0, r.res.stdout);
  let m = readManifest(dir);
  const e0 = m.entries["term-01"];
  assert.equal(e0.model, "web");
  assert.equal(e0.model_fingerprint, "image-use:web");

  env = iuEnv(null, { IMAGE_USE_BACKEND: "codex" });
  r = runGen(dir, ["--only-ids", "term-01"], { env, provider: "image-use" });
  const calls = iuCalls(env);
  assert.ok(calls.length > 0, "切 backend 后必须重新生成（不复用旧 web 结果）");
  // stale 走候选链自动提升；提升后主链指纹必须已回写 codex（否则永久 stale 循环）
  m = readManifest(dir);
  const e1 = m.entries["term-01"];
  assert.equal(e1.status, "succeeded");
  assert.equal(e1.model, "codex");
  assert.equal(e1.model_fingerprint, "image-use:codex", "提升后回写指纹（修复：停畱旧值会永久重复生成）");

  // 危害断言：同 backend 再跑必须零请求（指纹未回写时会无限 stale 重复计费）
  const env2 = iuEnv(null, { IMAGE_USE_BACKEND: "codex" });
  r = runGen(dir, ["--only-ids", "term-01"], { env: env2, provider: "image-use" });
  assert.equal(r.res.status, 0, r.res.stdout);
  assert.equal(iuCalls(env2).length, 0, "指纹回写后同输入零请求（未回写则每次 batch 重复生成）");
});