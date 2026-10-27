#!/usr/bin/env node
// 设计计划校验闸（P0-B T4）：image-design-plan.json 的 schema 校验。
// Prepare 的 agent 产物必须过本闸才能落盘生效（与 convert.mjs --validate-only 同模式）。
//
// 校验项（方案 V2.1 第七节 + D6 兼容前置）：
//   - version === 1；article_id / visual_profile 非空
//   - items 非空数组；type 枚举；cover 类型至多一条
//   - id 匹配 D6 同款正则 ^[a-z0-9][a-z0-9-]*$ 且唯一（保证编译产物必过 D6）
//   - concept / layout 非空；aspect_ratio 格式 N:N
//   - source_facts：infographic / data-chart 必须非空数组（内容忠实性硬要求）
//   - filename 若有，必须是安全文件名（复用 lib/validate.mjs）
//
// 输出契约：
//   [VALID] ok items=<n> warnings=<n>       exit 0
//   [VALID] errors=<n> <前 5 条>            exit 2
//   [FAIL] <原因>                           exit 2（参数/读取失败）
import { readFileSync, existsSync } from "node:fs";
import { isSafeImageFilename } from "./lib/validate.mjs";

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const TYPES = new Set(["cover", "infographic", "data-chart", "illustration"]);
const RATIO_RE = /^\d+(\.\d+)?[:x]\d+(\.\d+)?$/;

const argv = process.argv.slice(2);
function fail(msg) {
  console.log(`[FAIL] ${msg}`);
  process.exit(2);
}

const target = argv.find((a) => !a.startsWith("--"));
if (!target) fail("用法: validate-plan.mjs <plan.json 路径>");
if (!existsSync(target)) fail(`计划文件不存在: ${target}`);

let plan;
try {
  plan = JSON.parse(readFileSync(target, "utf8"));
} catch (e) {
  fail(`JSON 解析失败: ${e.message}`);
}

const errors = [];
const warnings = [];
const bad = (msg) => errors.push(msg);

if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
  bad("计划必须是 JSON 对象");
  report();
}
if (plan.version !== 1) bad(`version 必须为 1，收到 ${JSON.stringify(plan.version)}`);
if (typeof plan.article_id !== "string" || !plan.article_id.trim()) bad("article_id 必须是非空字符串");
if (typeof plan.visual_profile !== "string" || !plan.visual_profile.trim()) bad("visual_profile 必须是非空字符串");
if (typeof plan.source_article_hash !== "string" || !plan.source_article_hash.trim()) {
  warnings.push("缺少 source_article_hash（文章内容哈希），缓存判断将退化");
}
if (!Array.isArray(plan.items) || plan.items.length === 0) {
  bad("items 必须是非空数组");
  report();
}
if (plan.items.length > 50) warnings.push(`items 共 ${plan.items.length} 条，超过 50 条建议分批（费用与时长考虑）`);

const seenIds = new Set();
let coverCount = 0;
plan.items.forEach((it, i) => {
  const at = `items[${i}]`;
  if (it === null || typeof it !== "object" || Array.isArray(it)) {
    bad(`${at} 必须是对象`);
    return;
  }
  if (typeof it.id !== "string" || !ID_RE.test(it.id)) {
    bad(`${at}.id 非法（须匹配 ${ID_RE}，保证编译产物过 D6）：${JSON.stringify(it.id)}`);
  } else if (seenIds.has(it.id)) {
    bad(`${at}.id 重复：${it.id}`);
  } else {
    seenIds.add(it.id);
  }
  if (!TYPES.has(it.type)) {
    bad(`${at}(${it.id ?? "?"}).type 必须是 ${[...TYPES].join("|")}，收到 ${JSON.stringify(it.type)}`);
  } else if (it.type === "cover") {
    coverCount += 1;
    if (coverCount > 1) bad(`${at}(${it.id}) 出现第二个 cover 条目（至多一个）`);
  }
  if (typeof it.heading !== "string") bad(`${at}(${it.id ?? "?"}).heading 必须是字符串（cover 允许空串）`);
  if (typeof it.concept !== "string" || !it.concept.trim()) bad(`${at}(${it.id ?? "?"}).concept 必须是非空字符串`);
  if (typeof it.layout !== "string" || !it.layout.trim()) bad(`${at}(${it.id ?? "?"}).layout 必须是非空字符串`);
  if (typeof it.aspect_ratio !== "string" || !RATIO_RE.test(it.aspect_ratio)) {
    bad(`${at}(${it.id ?? "?"}).aspect_ratio 格式非法（应为 N:N 如 16:9）：${JSON.stringify(it.aspect_ratio)}`);
  }
  // 内容忠实性硬要求：结构与数据类条目必须有可溯源事实清单
  if (it.type === "infographic" || it.type === "data-chart") {
    if (!Array.isArray(it.source_facts) || it.source_facts.length === 0 || it.source_facts.some((f) => typeof f !== "string" || !f.trim())) {
      bad(`${at}(${it.id ?? "?"}).source_facts 必须是非空字符串数组（${it.type} 的内容忠实性硬要求）`);
    }
  } else if (it.source_facts !== undefined && !Array.isArray(it.source_facts)) {
    bad(`${at}(${it.id ?? "?"}).source_facts 若提供必须是数组`);
  }
  if (it.filename !== undefined && (typeof it.filename !== "string" || !isSafeImageFilename(it.filename))) {
    bad(`${at}(${it.id}).filename 非法（路径逃逸/保留名/扩展名）：${JSON.stringify(it.filename)}`);
  }
});

function report() {
  if (errors.length > 0) {
    console.log(`[VALID] errors=${errors.length} ${errors.slice(0, 5).join(" | ")}`);
    process.exit(2);
  }
  console.log(`[VALID] ok items=${plan.items.length} warnings=${warnings.length}${warnings.length ? " " + warnings.join(" | ") : ""}`);
  process.exit(0);
}
report();
