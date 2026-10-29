#!/usr/bin/env node
// 提示词审批文档渲染器（IMG-L 后续，方案 dev-docs/design/2026-10-28-提示词审批文档渲染方案.md）：
// 把 image-prompts.json（+ 可选 manifest）渲染成人类可读的《统一配图风格与提示词审批文档》markdown。
// 定位：只读渲染（唯一写入是输出文档本身），不碰 manifest/prompts/plan，不取锁，不发请求。
// 用途：用户在"生成前"审每张图的完整提示词成稿提调整；"生成后"同一文档回填状态与审核结论。
//
// 用法：node export-review.mjs --article-dir <dir> [--out <path>]
// 输出：缺省 <article_dir>/review-image-prompts.md（review- 前缀命中正文定位排除规则 ^(article|draft|review)，避免审批文档干扰 md 唯一性判定）；stdout 打印 [REVIEW] <路径> 与摘要。
// 退出码：0 成功；2 输入缺失/非法。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { normalizePrompts, validatePrompts } from "./lib/validate.mjs";
import { checkMetaConsistency, META_NAME } from "./lib/meta.mjs";
import { loadManifest } from "./lib/manifest.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..", "..", "..");
const VISUAL_DIR = path.join(REPO_ROOT, "dev-examples", "wx-article", "visual");

const STATUS_CN = {
  pending: "待生成",
  running: "生成中",
  succeeded: "生成成功",
  failed: "失败",
  unknown: "扣费不确定（待人工）",
  stale: "输入已变（待重生成）",
};
const REVIEW_CN = { pending: "待人工审核", approved: "文字审核通过", rejected: "文字审核拒绝" };

function fail(msg) {
  console.log(`[FAIL] ${msg}`);
  process.exit(2);
}

// ---------- 参数 ----------
const argv = process.argv.slice(2);
function arg(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}
const articleDirArg = arg("--article-dir");
if (!articleDirArg) fail("用法: export-review.mjs --article-dir <dir> [--out <path>]");
const articleDir = path.resolve(articleDirArg);
if (!existsSync(articleDir)) fail(`文章目录不存在: ${articleDir}`);

const promptsPath = path.join(articleDir, "image-prompts.json");
if (!existsSync(promptsPath)) fail(`缺少 image-prompts.json（先 compile 或 convert）: ${promptsPath}`);

// ---------- 读取 ----------
const jsonRaw = readFileSync(promptsPath, "utf8");
const jsonSha = crypto.createHash("sha256").update(jsonRaw, "utf8").digest("hex");
let doc;
try {
  doc = JSON.parse(jsonRaw);
} catch (e) {
  fail(`image-prompts.json 解析失败: ${e.message}`);
}
const v = validatePrompts(doc);
if (!v.ok) fail(`image-prompts.json 未过 D6 校验: ${v.errors.slice(0, 3).join("；")}`);
const prompts = normalizePrompts(doc);

// meta 配套状态（compile/convert 产物才有；仅展示，不阻断渲染——审批文档允许看"未配套"的旧 json）
let metaLine = "无 meta（非 compile/convert 产物或已被移动）";
const metaPath = path.join(articleDir, META_NAME);
if (existsSync(metaPath)) {
  const cm = checkMetaConsistency(promptsPath, metaPath);
  metaLine = cm.ok
    ? `配套校验通过（compiler ${cm.meta.compiler_version}，来源 ${cm.meta.source ?? "?"}，写入 ${cm.meta.written_at ?? "?"}）`
    : `不配套（${cm.reason}）——文档内容可能与最新编译不一致，建议先重编译`;
}

// manifest（可选：未生成过的目录也能渲染）
let manifest = null;
try {
  const r = await loadManifest(articleDir);
  manifest = r.existed ? r.doc : null;
} catch {
  manifest = null; // 损坏时不阻断渲染，状态节标注
}

const entryOf = (id) => manifest?.entries?.[id] ?? null;
const statusCn = (e) => (e ? (STATUS_CN[e.status] ?? e.status) : (manifest ? "台账无此条目" : "未生成（无 manifest）"));
const reviewCn = (e) => {
  const cr = e?.content_review;
  if (!cr) return null;
  return REVIEW_CN[cr.status] ?? cr.status;
};

// ---------- 渲染 ----------
const lines = [];
const absPath = (p) => (p ? path.join(articleDir, p) : "");
lines.push(`# ${doc.article_id}｜统一配图风格与提示词审批文档`);
lines.push("");
lines.push("> 用途：生成前审批每张图的完整提示词成稿；生成后同一文档回填状态与审核结论。");
lines.push("> 本文档由 export-review.mjs 只读渲染，改任何内容请改源头（plan / visual 规则）后重编译再渲染。");
lines.push("");
lines.push("## 文档信息");
lines.push("");
lines.push(`- 渲染时间：${new Date().toISOString()}`);
lines.push(`- prompts 内容哈希：\`${jsonSha.slice(0, 16)}…\`（${metaLine}）`);
const summary = {
  total: prompts.items.length,
  succeeded: 0, failed: 0, pending: 0, unknown: 0, other: 0,
  textPending: 0, textApproved: 0, textRejected: 0,
};
for (const it of prompts.items) {
  const e = entryOf(it.id);
  if (!e || !STATUS_CN[e.status]) { summary.other += 1; continue; }
  if (e.status === "succeeded") summary.succeeded += 1;
  else if (e.status === "failed") summary.failed += 1;
  else if (e.status === "unknown") summary.unknown += 1;
  else summary.pending += 1;
  const rc = reviewCn(e);
  if (rc === "待人工审核") summary.textPending += 1;
  else if (rc === "文字审核通过") summary.textApproved += 1;
  else if (rc === "文字审核拒绝") summary.textRejected += 1;
}
lines.push(`- 生成状态：成功 ${summary.succeeded} / 失败 ${summary.failed} / 待生成 ${summary.pending} / 扣费不确定 ${summary.unknown}${summary.other ? ` / 其他 ${summary.other}` : ""}（共 ${summary.total} 张）`);
lines.push(`- 文字审核：待审 ${summary.textPending} / 通过 ${summary.textApproved} / 拒绝 ${summary.textRejected}`);
lines.push("");

lines.push("## 一、风格定位（全篇共享 style_prefix）");
lines.push("");
lines.push("以下段落会拼进每张图的提示词头部（真正发给生图模型的内容），改这里 = 全篇画风变化：");
lines.push("");
lines.push("```text");
lines.push(doc.style_prefix || "（空——账号/栏目规则未配置 prompt-block）");
lines.push("```");
lines.push("");
lines.push(`规则来源：\`${path.relative(REPO_ROOT, VISUAL_DIR)}\`（账号级 visual-rules.md + 栏目 series/*.md + 类型 types/*.md 三层，compile 时合成）。`);
lines.push("");

lines.push("## 二、逐张图审批明细");
lines.push("");
let seq = 0;
for (const it of prompts.items) {
  seq += 1;
  const kindCn = it.kind === "cover" ? "封面" : "正文图";
  const typeCn = typeof it.diagram_type === "string" && it.diagram_type.trim() ? `·${it.diagram_type.trim()}` : "";
  const e = entryOf(it.id);
  lines.push(`### ${String(seq).padStart(2, "0")}. ${it.id}（${kindCn}${typeCn}，${it.filename}）`);
  lines.push("");
  if (it.heading) lines.push(`- 对应章节：${it.heading}`);
  lines.push(`- 生图类型：${typeof it.diagram_type === "string" && it.diagram_type.trim() ? it.diagram_type.trim() : "（未标注，默认风格图）"}`);
  const st = statusCn(e);
  const statParts = [`生成状态：${st}`];
  if (e?.path) statParts.push(`图片：\`${e.path}\``);
  if (e?.duration_ms) statParts.push(`耗时 ${e.duration_ms}ms`);
  if (e?.error_code) statParts.push(`失败分类 \`${e.error_code}\``);
  if (e?.evidence_log) statParts.push(`证据 \`${e.evidence_log}\``);
  lines.push(`- ${statParts.join("；")}`);
  const rc = reviewCn(e);
  if (it.expected_text) {
    const rv = rc ?? "未生成，生成后须人工核对";
    lines.push(`- 文字要求（expected_text，${rv}）：`);
    for (const t of it.expected_text) lines.push(`  - ${t}`);
  } else if (rc) {
    lines.push(`- 文字审核：${rc}`);
  }
  lines.push("");
  lines.push("**完整提示词成稿**（style_prefix + 分隔符 + 单张 prompt，即实际发送内容）：");
  lines.push("");
  lines.push("```text");
  lines.push(`${doc.style_prefix || ""}\n---\n${it.prompt}`);
  lines.push("```");
  lines.push("");
}

lines.push("## 三、调整反馈指引");
lines.push("");
lines.push("看上面的成稿，直接说明哪张图要怎么改。调整改在源头，不在本文档：");
lines.push("");
lines.push("| 想改什么 | 改哪里 | 改后动作 |");
lines.push("|---|---|---|");
lines.push("| 某张图的画面内容/构图 | image-design-plan.json 对应条目 concept/layout | 重新 compile → 重新渲染本文档 |");
lines.push("| 某张图必须出现的文字 | plan 条目 expected_text | 重新 compile → 重新渲染（纯改要求不触发重新付费生成） |");
lines.push("| 全篇画风 | visual/series/ 或 visual-rules.md 的 prompt-block | 重新 compile → 风格审批自动失效，需重新 preview 签样 |");
lines.push("| 图片文件被手动替换 | 无需改（下次 batch 前 --verify-only 会提示 missing） | 建议同步更新或删除 manifest 条目 |");
lines.push("");
lines.push("重编译后本文档哈希变化 = 提示词已变，需重新过目；生成/审核动作完成后重渲染本文档即可看到最新状态。");
lines.push("");

const outPath = path.resolve(arg("--out") ?? path.join(articleDir, "review-image-prompts.md"));
writeFileSync(outPath, lines.join("\n"), "utf-8");
console.log(`[REVIEW] ${outPath}`);
console.log(`[REVIEW] 张数=${summary.total} 成功=${summary.succeeded} 失败=${summary.failed} 待生成=${summary.pending} unknown=${summary.unknown} 文字待审=${summary.textPending}`);
