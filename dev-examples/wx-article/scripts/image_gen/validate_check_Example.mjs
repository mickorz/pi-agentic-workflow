#!/usr/bin/env node
/**
 * validate.mjs 产物自检验证（wx-a1 遗留③）
 * 断言：元数据残片 prompt（filename:/kind: 开头）→ error；prompt 过短(<10) → error；
 *       空 style_prefix → warning 不阻断；正常清单 → ok。
 * 用法：node validate_check_Example.mjs（exit 0/1）
 */
import { validatePrompts } from "./lib/validate.mjs";

const PASS = [];
const FAIL = [];

function check(name, cond) {
  (cond ? PASS : FAIL).push(name);
  console.log(`[${cond ? "PASS" : "FAIL"}] ${name}`);
}

const base = {
  version: 1, article_id: "ai", style_prefix: "科技感插画",
  items: [{ id: "cover", kind: "cover", heading: "## 封面", prompt: "一位开发者面对两条发光岔路，远方是齿轮引擎装置", filename: "cover.png" }],
};

// 1 正常清单 → ok
check("正常清单 ok", validatePrompts(base).ok === true);

// 2 元数据残片（真机踩坑场景：prompt="filename: cover.png"）→ error
const bad1 = JSON.parse(JSON.stringify(base));
bad1.items[0].prompt = "filename: cover.png";
const v1 = validatePrompts(bad1);
check("元数据残片 prompt 被拒", v1.ok === false && v1.errors.some((e) => e.includes("元数据残片")));

// 3 kind: 开头同样被拒
const bad2 = JSON.parse(JSON.stringify(base));
bad2.items[0].prompt = "kind: cover";
check("kind: 残片被拒", validatePrompts(bad2).ok === false);

// 4 prompt 过短 → error
const bad3 = JSON.parse(JSON.stringify(base));
bad3.items[0].prompt = "一只猫";
const v3 = validatePrompts(bad3);
check("过短 prompt(<10) 被拒", v3.ok === false && v3.errors.some((e) => e.includes("过短")));

// 5 空 style_prefix → warning 不阻断
const warn1 = JSON.parse(JSON.stringify(base));
warn1.style_prefix = "";
const v5 = validatePrompts(warn1);
check("空 style_prefix 不阻断", v5.ok === true && v5.warnings.some((w) => w.includes("style_prefix")));

console.log(`\n=== ALL ${FAIL.length === 0 ? "PASS" : "FAILED"} ===（PASS ${PASS.length} / FAIL ${FAIL.length}）`);
process.exit(FAIL.length === 0 ? 0 : 1);
