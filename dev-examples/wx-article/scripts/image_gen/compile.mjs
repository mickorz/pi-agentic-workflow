#!/usr/bin/env node
// 设计计划编译器（P0-B T5 + T6 + T8）：image-design-plan.json + 视觉规则 → image-prompts.json（D6 V1）+ image-prompts.meta.json
// 零 LLM、确定性、可重复。落盘前过 lib/validate.mjs 的 D6 校验闸。
//
// 组合顺序（方案 V2.1 第五节，Compiler 固定）：
//   style_prefix  = 账号级 prompt-block + 栏目 prompt-block（整篇真正共享的规则）
//   items[].prompt = 类型 prompt-block + 图位内容(heading/concept/layout/source_facts) + 输出要求
// 尺寸：P0 维持全局 IMAGE_GEN_SIZE；plan 的 aspect_ratio 仅记录不生效（P1-B T12/T13 接入）。
//
// 哈希体系（V2.1 §6.1/§6.2）：
//   - effective hash 直接复用 manifest.promptHash 口径 sha256(style_prefix+"---"+prompt)，
//     保证差异报告与执行器失效判定天然一致（P0 不旁路执行器判断）
//   - rules_hash 按账号级/类型/栏目分桶，支撑「改某类型规则只失效该类型条目」
//   - plan_hash 只含设计语义（不含 filename 等管理字段）
//   - meta 记录 json_content_hash；读取侧 --check-meta 强制配套校验，不匹配拒绝复用
//
// 输出契约：
//   [COMPILE] items=<n> style=<len> profile=<id>      （编译摘要）
//   [DIFF] changed=<ids> added=<ids> removed=<ids>    （与既有 json 的 effective 差异；无既有则全 added）
//   [RESULT] <json 路径与统计>
//   [META] ok / [META] mismatch <原因>                （--check-meta）
//   [VALID] ok ... / [VALID] errors=...               （--validate-only 复用 D6 闸）
//   [FAIL] <原因>                                     exit 2
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validatePrompts, normalizePrompts } from "./lib/validate.mjs";
import { promptHash } from "./lib/manifest.mjs";
import { COMPILER_VERSION, sha256Hex, writeJsonWithMeta, checkMetaConsistency, META_NAME } from "./lib/meta.mjs";

const sha256 = sha256Hex;

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
}
function fail(msg) {
  console.log(`[FAIL] ${msg}`);
  process.exit(2);
}

// ---------- --validate-only：D6 校验闸复用 ----------
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

// ---------- --check-meta：json/meta 配套校验（读取侧复用决策的唯一依据） ----------
if (argv.includes("--check-meta")) {
  const articleDir = arg("--check-meta");
  const jsonPath = arg("--out") ?? path.join(articleDir, "image-prompts.json");
  const r = checkMetaConsistency(jsonPath, path.join(path.dirname(jsonPath), META_NAME));
  if (!r.ok) {
    console.log(`[META] mismatch ${r.reason}`);
    process.exit(2);
  }
  console.log(`[META] ok items=${Object.keys(r.meta.items_effective_hash ?? {}).length}`);
  process.exit(0);
}

// ---------- 主流程：编译 ----------
const articleDir = arg("--article-dir");
if (!articleDir) fail("--article-dir 必填（或用 --validate-only / --check-meta）");
const planPath = arg("--plan") ?? path.join(articleDir, "image-design-plan.json");
if (!existsSync(planPath)) fail(`设计计划不存在: ${planPath}（先运行 article_image_prompt_prepare）`);
let plan;
try {
  plan = JSON.parse(readFileSync(planPath, "utf8"));
} catch (e) {
  fail(`计划 JSON 解析失败: ${e.message}`);
}
if (plan.version !== 1 || !Array.isArray(plan.items) || plan.items.length === 0) {
  fail("计划非法（version/items）——先过 validate-plan.mjs");
}
const profile = plan.visual_profile;

// 视觉规则目录：默认相对本脚本定位（image_gen/ → scripts/ → wx-article/ → visual/），可参数覆盖
const VISUAL_DIR = arg("--visual-dir") ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "visual");
const rulesPath = path.join(VISUAL_DIR, "visual-rules.md");
const typePath = (t) => path.join(VISUAL_DIR, "types", `${t}.md`);
const seriesPath = path.join(VISUAL_DIR, "series", `${profile}.md`);
for (const p of [rulesPath, seriesPath]) {
  if (!existsSync(p)) fail(`规则文件缺失: ${p}`);
}

// prompt-block 提取：## prompt-block 段内非空行（到下一个 ## 或文件尾）
function promptBlock(file) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const out = [];
  let inBlock = false;
  for (const l of lines) {
    if (/^##\s+/.test(l)) {
      if (inBlock) break;
      inBlock = /^##\s+prompt-block\s*$/.test(l.trim());
      continue;
    }
    if (inBlock && l.trim()) out.push(l.trim());
  }
  return out;
}
if (!promptBlock(rulesPath).length) fail(`visual-rules.md 缺少非空 prompt-block: ${rulesPath}`);

const accountBlock = promptBlock(rulesPath);
const seriesRaw = readFileSync(seriesPath, "utf8");
const seriesBlock = promptBlock(seriesPath);
if (!seriesBlock.length) fail(`栏目规则缺少非空 prompt-block: ${seriesPath}`);
// medium-override（栏目媒介接管）：栏目自带完整品牌风格（如 3D 信息图）时不叠加账号默认媒介（水彩），
// style_prefix 全量用栏目 prompt-block。改账号规则对此类栏目文章不触发任何失效（prompt 不含账号段）。
const mediumOverride = /^>\s*medium-override:\s*true\s*$/m.test(seriesRaw);
const stylePrefix = mediumOverride ? seriesBlock.join("\n") : [...accountBlock, ...seriesBlock].join("\n");

const jsonPath = arg("--out") ?? path.join(articleDir, "image-prompts.json");

// 与既有 json 的 effective 差异（仅当配套校验通过时才有意义；不配套按全量 added 报告）
const cm = existsSync(jsonPath) ? checkMetaConsistency(jsonPath, path.join(path.dirname(jsonPath), META_NAME)) : { ok: false, meta: null };
const prevEffective = cm.ok ? cm.meta.items_effective_hash ?? {} : null;

const TYPE_ABBR = { cover: "cv", infographic: "ig", "data-chart": "dc", illustration: "il" };
const items = [];
const usedIds = new Set();
const usedFilenames = new Set();
let bodySeq = 0;
for (const it of plan.items) {
  const typeBlock = promptBlock(typePath(it.type));
  if (!typeBlock.length) fail(`类型规则缺少非空 prompt-block: ${typePath(it.type)}`);
  const kind = it.type === "cover" ? "cover" : "body";
  const seq = kind === "cover" ? 0 : ++bodySeq;

  // filename：继承 plan 已有（稳定 ID 锁定），否则首次分配
  let filename = it.filename;
  if (filename === undefined || filename === "") {
    filename = kind === "cover" ? "cover.png" : `${String(seq).padStart(2, "0")}-${it.id}.png`;
  }
  if (usedFilenames.has(filename)) fail(`filename 重复: ${filename}（id=${it.id}）`);
  usedFilenames.add(filename);

  // 图位内容段：事实清单逐条列出（信息图/数据图忠实性来源）
  const facts = Array.isArray(it.source_facts) && it.source_facts.length
    ? "事实清单（内容必须忠实于以下条目，不得增删编造）：\n" + it.source_facts.map((f) => `- ${f}`).join("\n")
    : "";
  const prompt = [
    ...typeBlock,
    `本章内容：${it.heading || it.concept}`,
    `画面概念：${it.concept}`,
    `构图布局：${it.layout}`,
    ...(facts ? [facts] : []),
  ].join("\n");

  // T4（IMG-L 阶段二）：expected_text 纯透传，刻意不进 prompt 合成——若进 prompt 会改变
  // prompt_hash，破坏“仅改验收要求不得触发重新付费生图”的失效规则（V2 方案原文与此冲突，以失效规则优先）；
  // T0 取证已证明负向文字约束在 web 后端无效，正向约束增益未验证，不为未验证增益牺牲确定性失效语义。
  items.push({ id: it.id, kind, heading: it.heading ?? "", prompt, filename, ...(Array.isArray(it.expected_text) && it.expected_text.length ? { expected_text: it.expected_text } : {}) });
  usedIds.add(it.id);
}
if (usedIds.size !== items.length) fail("plan 存在重复 id（先过 validate-plan.mjs）");

const doc = normalizePrompts({ version: 1, article_id: plan.article_id, style_prefix: stylePrefix, items });
const v = validatePrompts(doc);
if (!v.ok) {
  console.log(`[FAIL] 编译产物未过 D6 校验: ${v.errors.slice(0, 5).join(" | ")}`);
  process.exit(2);
}

// effective 哈希（与 manifest.promptHash 同口径——差异报告与执行器判定天然一致）
const effective = {};
for (const it of doc.items) effective[it.id] = promptHash(doc.style_prefix, it.prompt);

// 差异报告
const changed = [];
const added = [];
const removed = [];
if (prevEffective) {
  for (const it of doc.items) {
    if (!(it.id in prevEffective)) added.push(it.id);
    else if (prevEffective[it.id] !== effective[it.id]) changed.push(it.id);
  }
  for (const id of Object.keys(prevEffective)) if (!(id in effective)) removed.push(id);
} else {
  for (const it of doc.items) added.push(it.id);
}

// 规则分桶哈希（T6）：改某桶只影响对应条目
const rulesHash = {
  account: sha256(readFileSync(rulesPath, "utf8")),
  types: {},
  series: { [profile]: sha256(readFileSync(seriesPath, "utf8")) },
};
for (const t of ["cover", "infographic", "data-chart", "illustration"]) {
  const p = typePath(t);
  if (existsSync(p)) rulesHash.types[t] = sha256(readFileSync(p, "utf8"));
}

// plan_hash：只含设计语义（不含 filename 等管理字段）
const planHash = sha256(JSON.stringify({
  article_id: plan.article_id,
  visual_profile: profile,
  items: plan.items.map((it) => ({
    id: it.id, type: it.type, heading: it.heading, concept: it.concept,
    layout: it.layout, aspect_ratio: it.aspect_ratio, source_facts: it.source_facts ?? null,
  })),
}));

// ---------- 安全写入（V2.1 §6.2：共享 lib/meta.mjs，meta 记录 json_content_hash，读取侧强制配套校验） ----------
writeJsonWithMeta(jsonPath, doc, {
  source: "plan",
  article_hash: plan.source_article_hash ?? null,
  plan_hash: planHash,
  rules_hash: rulesHash,
  items_effective_hash: effective,
});

console.log(`[COMPILE] items=${doc.items.length} style=${stylePrefix.length} profile=${profile}`);
console.log(`[DIFF] changed=${changed.join(",") || "-"} added=${added.join(",") || "-"} removed=${removed.join(",") || "-"}`);
console.log(`[RESULT] ${jsonPath}（meta: ${path.join(path.dirname(jsonPath), META_NAME)}，plan_hash=${planHash.slice(0, 12)}，compiler=${COMPILER_VERSION}）`);
