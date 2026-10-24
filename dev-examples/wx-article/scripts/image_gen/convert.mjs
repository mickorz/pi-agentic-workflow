#!/usr/bin/env node
// 提示词转换器（T2.1）：image-prompts.md / 配图建议.md → image-prompts.json
//
// 设计（需求 §"独立的解析/转换步骤"）：转换是一次性动作（每文章一次），执行器永不重解释 md。
// - 确定性解析优先：能结构化解析就直接落盘（零 LLM、可重复）。
// - 低置信度（解析不出提示词）→ exit 3 [NEED-LLM]，由 workflow 用 agent+schema 兜底，
//   兜底产物仍必须过本脚本 --validate-only 的 D6 校验闸。
//
// 输出契约：
//   [PARSE] items=<n> confident=<bool> style=<len>   （解析摘要）
//   [RESULT] <json 路径与统计>                        （成功落盘）
//   [NEED-LLM] <原因>                                 exit 3
//   [FAIL] <原因>                                     exit 2（参数/校验失败）
//   [VALID] ok / [VALID] errors=<n>                   (--validate-only)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { validatePrompts, normalizePrompts } from "./lib/validate.mjs";

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
}
const articleDir = arg("--article-dir");
const mdArg = arg("--md");
const outArg = arg("--out");
const force = argv.includes("--force");

function fail(msg) {
  console.log(`[FAIL] ${msg}`);
  process.exit(2);
}

// ---------- --validate-only：D6 校验闸（workflow agent 兜底后的必经关卡） ----------
if (argv.includes("--validate-only")) {
  const target = arg("--validate-only");
  if (!target || !existsSync(target)) fail(`清单不存在: ${target}`);
  let doc;
  try {
    doc = JSON.parse(readFileSync(target, "utf8"));
  } catch (e) {
    fail(`JSON 解析失败: ${e.message}`);
  }
  const v = validatePrompts(doc);
  if (!v.ok) {
    console.log(`[VALID] errors=${v.errors.length} ${v.errors.slice(0, 5).join(" | ")}`);
    process.exit(2);
  }
  console.log(`[VALID] ok items=${doc.items.length} warnings=${v.warnings.length}`);
  process.exit(0);
}

if (!articleDir) fail("--article-dir 必填（或用 --validate-only <path>）");

// ---------- 定位源 md ----------
const candidates = [
  mdArg,
  path.join(articleDir, "image-prompts.md"),
  path.join(articleDir, "配图建议.md"),
].filter(Boolean);
const mdPath = candidates.find((p) => existsSync(p));
if (!mdPath) fail(`未找到提示词 md（按序探测: ${candidates.join(", ")}）`);
const outPath = outArg ?? path.join(articleDir, "image-prompts.json");
if (existsSync(outPath) && !force) {
  console.log(`[RESULT] exists ${outPath}（已存在，--force 覆盖）`);
  process.exit(0);
}

// ---------- 确定性解析 ----------
// 支持的 md 形态（常见自由格式的并集；每种都要求「标题 + 提示词」成对）：
//   ##/### 章节式：  "## 标题" 下含 "提示词：xxx" / "- 提示词: xxx" / 代码块
//   编号列表式：    "1. **标题**" + 缩进提示词行
//   表格式：        | 标题 | 提示词 |（表头含"提示词"）
const md = readFileSync(mdPath, "utf8");
const lines = md.split(/\r?\n/);

function slug(s) {
  // id/filename 用 ASCII 安全 slug：取英文部分；纯中文标题回退 img-<seq>/term-<seq>
  const ascii = s
    .replace(/[（(].*?[)）]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return ascii || null; // null → 由调用方用序号回退
}
let seqCounter = 0;
function slugOrSeq(s) {
  return slug(s) ?? `term-${String(++seqCounter).padStart(2, "0")}`;
}
function stripQuote(s) {
  return s.trim().replace(/^["'「『]|["'」』]$/g, "").trim();
}
function extractPrompt(blockLines) {
  // 优先级：提示词标签行 > 代码块 > "Prompt:" 行 > 长句行（>=20 字且非标题非列表标记）
  for (const l of blockLines) {
    const m = l.match(/^\s*(?:[-*]\s*)?(?:提示词|prompt|生图提示?词?)\s*[:：]\s*(.+)$/i);
    if (m && stripQuote(m[1]).length >= 8) return stripQuote(m[1]);
  }
  let inCode = false;
  const code = [];
  for (const l of blockLines) {
    if (/^```/.test(l.trim())) {
      if (inCode && code.length) return stripQuote(code.join(" ").trim());
      inCode = !inCode;
      continue;
    }
    if (inCode) code.push(l);
  }
  const long = blockLines
    .filter((l) => !/^#{1,6}\s/.test(l) && l.trim().length >= 20 && !/^\s*[-*]\s*\[/.test(l))
    .map((l) => l.replace(/^\s*[-*]\s*/, "").trim());
  return long.length ? stripQuote(long[0]) : null;
}

const sections = []; // {title, prompt}
let cur = null;
const styleHints = [];
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  const h = l.match(/^(#{2,4})\s+(.+)$/);
  const num = l.match(/^\s*(\d+)[.、)]\s*\*?\*?(.+?)\*?\*?\s*$/);
  if (h || num) {
    if (cur) sections.push(cur);
    const title = (h ? h[2] : num[2]).trim();
    cur = { title, prompt: null, lines: [] };
    continue;
  }
  if (!cur) {
    const sm = l.match(/^\s*(?:(?:全局|整体)?风格|style[_ ]?prefix)\s*[:：]\s*(.+)$/i);
    if (sm) styleHints.push(stripQuote(sm[1]));
    continue;
  }
  cur.lines.push(l);
}
if (cur) sections.push(cur);
for (const s of sections) s.prompt = extractPrompt(s.lines);

// 表格形态
if (!sections.some((s) => s.prompt)) {
  const rows = lines.filter((l) => l.trim().startsWith("|")).map((l) => l.split("|").map((c) => c.trim()));
  const head = rows.find((r) => r.some((c) => /提示词|prompt/i.test(c)));
  if (head) {
    const pi = head.findIndex((c) => /提示词|prompt/i.test(c));
    const ti = head.findIndex((c, ix) => ix !== pi && /标题|章节|heading|标题/i.test(c));
    for (const r of rows.slice(rows.indexOf(head) + 1)) {
      if (r.length < 2 || /^[-\s|:]+$/.test(r.join("|"))) continue;
      const title = ti >= 0 ? r[ti] : r[1];
      const prompt = r[pi];
      if (title && prompt && prompt.length >= 8) sections.push({ title, prompt });
    }
  }
}

const parsed = sections.filter((s) => s.prompt && s.prompt.length >= 8);
const confident = parsed.length > 0 && parsed.length === sections.length && sections.length > 0;
console.log(`[PARSE] sections=${sections.length} withPrompt=${parsed.length} confident=${confident}`);

if (!confident) {
  const missing = sections.filter((s) => !s.prompt).map((s) => s.title).slice(0, 5);
  console.log(`[NEED-LLM] 确定性解析覆盖不全（${parsed.length}/${sections.length}）${missing.length ? "；缺提示词章节: " + missing.join(" / ") : ""}`);
  process.exit(3);
}

// ---------- 组装清单 ----------
const articleId = slug(path.basename(articleDir)) ?? "article";
const items = [];
const seenIds = new Set();
function uniqueId(base) {
  let id = base;
  let n = 2;
  while (seenIds.has(id)) id = `${base}-${n++}`;
  seenIds.add(id);
  return id;
}
let bodyIdx = 0;
for (const s of parsed) {
  const isCover = /封面|cover/i.test(s.title);
  if (isCover && items.some((it) => it.kind === "cover")) continue; // 多封面取首个
  items.push({
    id: uniqueId(isCover ? "cover" : slugOrSeq(s.title).slice(0, 30)),
    kind: isCover ? "cover" : "body",
    heading: isCover ? "" : (s.title.startsWith("##") ? s.title : `## ${s.title}`),
    prompt: s.prompt,
    filename: isCover
      ? "cover.png"
      : (() => {
          const sl = slug(s.title);
          const seq = ++bodyIdx; // 稳定序号（标题带编号则沿用编号，避免 01-01- 双编号）
          const nn = sl?.match(/^(\d{1,2})-/) ? Number(sl.match(/^(\d{1,2})-/)[1]) : seq;
          const stem = sl ? sl.replace(/^\d{1,2}-/, "") : `term-${String(seq).padStart(2, "0")}`;
          return `${String(nn).padStart(2, "0")}-${stem}.png`;
        })(),
  });
}
const doc = {
  version: 1,
  article_id: articleId,
  style_prefix: styleHints.join("；"),
  items,
};
const v = validatePrompts(doc);
if (!v.ok) {
  console.log(`[FAIL] 转换产物未过 D6 校验: ${v.errors.join(" | ")}`);
  process.exit(2);
}
writeFileSync(outPath, JSON.stringify(normalizePrompts(doc), null, 2), "utf8");
console.log(`[RESULT] ${outPath} items=${items.length}（确定性解析，零 LLM）`);
console.log(`=== ALL DONE ===`);
