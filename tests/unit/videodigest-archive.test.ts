/** videodigest workflow-archive：archive_inspire.py 契约 + DSL 校验 + registry 注册（设计V2 §4/§6/§8） */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkflowScript } from "../../src/runtime/vm.js";
import { WorkflowRegistry } from "../../src/dispatch/registry.js";
import { readFileSync as rf } from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "dev-examples/videodigest/scripts/archive_inspire.py");
const DSL = path.join(ROOT, "dev-examples/videodigest/scripts/videodigest_extract.js");
const REGISTRY = path.join(ROOT, "dev-examples/videodigest/registry.json");

function runPy(args: string[]): { code: number; stdout: string } {
  const r = spawnSync("python3", [SCRIPT, ...args], { encoding: "utf8", timeout: 30_000 });
  return { code: r.status ?? -1, stdout: (r.stdout || "") + (r.stderr || "") };
}

function jsonOut(r: { code: number; stdout: string }): any {
  const line = r.stdout.split("\n").find((l) => l.trim().startsWith("{"));
  assert.ok(line, `stdout 无 JSON 行: ${r.stdout}`);
  return JSON.parse(line);
}

function freshVault(): string {
  return mkdtempSync(path.join(tmpdir(), "vd-vault-"));
}

function archive(vault: string, extra: string[]): any {
  return jsonOut(
    runPy([
      "archive",
      "--vault-root", vault,
      "--source-platform", "douyin",
      "--transcript-json", transcriptJson(vault),
      ...extra,
    ]),
  );
}

function transcriptJson(dir: string): string {
  const p = path.join(dir, "t.json");
  writeFileSync(p, JSON.stringify({ text: "逐字稿原文", segments: [] }), "utf8");
  return p;
}

test("check：空 vault → 未归档未占锁", () => {
  const v = freshVault();
  const out = jsonOut(runPy(["check", "--vault-root", v, "--source-key", "douyin:111"]));
  assert.equal(out.ok, true);
  assert.equal(out.archived, false);
  assert.equal(out.locked, false);
});

test("check：vault root 不存在 → 明确失败（不静默通过）", () => {
  const out = jsonOut(runPy(["check", "--vault-root", "/nonexistent/zz-vd", "--source-key", "douyin:x"]));
  assert.equal(out.ok, false);
  assert.match(out.error, /不是目录|未定位/);
});

test("lock：原子占位，二次占位 busy，陈锁接管", () => {
  const v = freshVault();
  const inspire = path.join(v, "60_Workspace/写作/灵感");
  const locks = path.join(inspire, ".vd/locks");
  const first = jsonOut(runPy(["lock", "--vault-root", v, "--source-key", "douyin:111"]));
  assert.equal(first.locked, true);
  assert.ok(existsSync(path.join(locks, "douyin_111.lock")));

  const second = jsonOut(runPy(["lock", "--vault-root", v, "--source-key", "douyin:111"]));
  assert.equal(second.locked, false);
  assert.equal(second.busy, true);

  // 31 分钟前的陈锁 → 接管
  mkdirSync(locks, { recursive: true });
  writeFileSync(path.join(locks, "douyin_222.lock"), JSON.stringify({ startedAt: (Date.now() - 31 * 60_000) / 1000, claimer: "x" }));
  const stale = jsonOut(runPy(["lock", "--vault-root", v, "--source-key", "douyin:222"]));
  assert.equal(stale.locked, true);
  assert.equal(stale.took_over, true);

  const unlocked = jsonOut(runPy(["unlock", "--vault-root", v, "--source-key", "douyin:111"]));
  assert.equal(unlocked.ok, true);
  assert.ok(!existsSync(path.join(locks, "douyin_111.lock")));
});

test("archive：0-raw.md 落盘（frontmatter+整理排版逐字稿，零 AI 评论），reflow 零内容修改，check 命中幂等", () => {
  const v = freshVault();
  // 多句逐字稿：验证断句+分段（句末标点后断句，句 4 句一段）与零内容修改
  const tPath = path.join(v, "t2.json");
  const raw = "第一句结束。第二句很长的内容在这里！第三句是疑问句？第四句短；第五句又开始了。第六句收尾。";
  writeFileSync(tPath, JSON.stringify({ text: raw, segments: [] }), "utf8");
  const out = jsonOut(
    runPy([
      "archive", "--vault-root", v, "--source-platform", "douyin",
      "--transcript-json", tPath,
      "--title", "测试标题", "--source-id", "111", "--source-url", "https://www.douyin.com/video/111",
      "--uploader", "作者甲", "--duration", "88",
    ]),
  );
  assert.equal(out.ok, true);
  assert.equal(out.duplicate, false);
  assert.equal(out.title, "测试标题");

  const mdPath = path.join(v, "60_Workspace/写作/灵感", out.rel_dir, "0-raw.md");
  const md = readFileSync(mdPath, "utf8");
  assert.match(md, /^---\n/);
  assert.match(md, /title: "测试标题"/);
  assert.match(md, /source_platform: douyin/);
  assert.match(md, /source_id: 111/);
  assert.match(md, /source_url: "https:\/\/www\.douyin\.com\/video\/111"/);
  assert.match(md, /status: 待消化/);
  assert.match(md, /tags: \[douyin, 作者甲\]/);
  assert.match(md, /# 测试标题/);
  // 零 AI 评论：不含任何提炼分节
  assert.ok(!md.includes("核心观点"));
  assert.ok(!md.includes("公众号的启发"));
  assert.ok(!md.includes("待核实"));
  assert.ok(!md.includes("AI 提炼"));
  // reflow 零内容修改：去掉换行后与原文逐字符相等；分段结构存在（≥2 段）
  const bodyStart = md.indexOf("# 测试标题") + "# 测试标题".length;
  const body = md.slice(bodyStart).trim();
  assert.equal(body.replace(/\n/g, ""), raw);
  assert.ok(body.split("\n\n").length >= 2, "应分段（句 4 句一段）");

  // check 命中幂等
  const check = jsonOut(runPy(["check", "--vault-root", v, "--source-key", "douyin:111"]));
  assert.equal(check.archived, true);
  assert.equal(check.rel_dir, out.rel_dir);

  // 同 sourceKey 再 archive → duplicate，不建新目录
  const dup = archive(v, ["--title", "其他标题", "--source-id", "111", "--source-url", "u"]);
  assert.equal(dup.duplicate, true);
  assert.equal(dup.rel_dir, out.rel_dir);
  const entries = path.join(v, "60_Workspace/写作/灵感");
  const subs = readdirSync(entries).filter((d) => !d.startsWith("."));
  assert.deepEqual(subs.sort(), [out.rel_dir]);
});

test("archive：不同视频撞标题 → 确定性序号后缀（非时间戳）", () => {
  const v = freshVault();
  archive(v, ["--title", "撞名", "--source-id", "1", "--source-url", "u"]);
  const b = archive(v, ["--title", "撞名", "--source-id", "2", "--source-url", "u"]);
  const c = archive(v, ["--title", "撞名", "--source-id", "3", "--source-url", "u"]);
  assert.equal(b.rel_dir, "撞名 (2)");
  assert.equal(c.rel_dir, "撞名 (3)");
});

test("archive：标题 sanitize（危险字符/超长）与目录逃逸硬约束", () => {
  const v = freshVault();
  const out = archive(v, ["--title", "../../etc/evil:标题*?", "--source-id", "9", "--source-url", "u"]);
  assert.equal(out.ok, true);
  assert.ok(!out.rel_dir.includes("/") && !out.rel_dir.includes("\\"), `rel_dir 含路径分隔符: ${out.rel_dir}`);
  // 所有产物必须位于灵感根前缀内
  const inspireRoot = path.join(v, "60_Workspace/写作/灵感");
  assert.ok(path.resolve(inspireRoot, out.rel_dir).startsWith(inspireRoot));

  const long = archive(v, ["--title", "这".repeat(30) + "个超长标题", "--source-id", "10", "--source-url", "u"]);
  assert.ok(long.title.length <= 20, `标题未截断: ${long.title.length}`);
});

test("DSL：videodigest_extract.js 通过确定性脚本校验（五阶段，无 AI 提炼）", () => {
  const src = readFileSync(DSL, "utf8");
  const { meta, body } = parseWorkflowScript(src);
  assert.equal(meta.name, "videodigest_extract");
  assert.equal(meta.phases.length, 5);
  // 幂等回执/占锁/释放路径存在；已无 AI 提炼阶段（用户新流程：零评论）
  assert.ok(!body.includes("wechat_inspirations"));
  assert.match(body, /lock/);
  assert.match(body, /unlock/);
  assert.match(body, /idempotent/);
});

test("registry：videodigest-extract 注册合法（write 级 + urlDomains 前置路由）", () => {
  const list = JSON.parse(rf(REGISTRY, "utf8"));
  const reg = new WorkflowRegistry(list);
  const wf = reg.get("videodigest-extract");
  assert.ok(wf, "未注册 videodigest-extract");
  assert.equal(wf.riskLevel, "write");
  assert.equal(wf.enabled, true);
  assert.deepEqual(wf.urlDomains ?? [], ["v.douyin.com", "www.douyin.com", "douyin.com", "www.iesdouyin.com", "iesdouyin.com"]);
  assert.equal(wf.urlArg, "url");
  assert.match(wf.scriptPath, /videodigest_extract\.js$/);
});
