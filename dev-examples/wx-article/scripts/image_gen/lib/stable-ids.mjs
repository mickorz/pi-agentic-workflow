#!/usr/bin/env node
// 稳定 ID 分级匹配（P0-C T9，方案 V2.1 第七节）：agent 设计语义 -> 确定性 id/filename 继承分配。
// 纯函数 matchAndAssign 供测试；本文件同时是 CLI（workflow DSL 不支持 import，Prepare 经 command 调用）。
//
// 分级规则（歧义即人工，宁可重新分配 ID，不错误继承已付费图片）：
//   L0 cover 天然唯一，新旧 cover 直接互认；
//   L1 heading 精确相等且 type 相同且未被占用，唯一命中才继承；
//   L2 顺序辅助仅在「正文条目全部 L1 未命中且数量相等且无歧义」时按位继承（防插入误绑）；
//   多候选/低置信度 -> conflicts，不自动继承，输出冲突报告供人工确认。
//
// CLI 契约：
//   node lib/stable-ids.mjs --new <designed.json> [--old <oldPlan.json>] [--resolve-new]
//   [MATCH] <json>    exit 0（含 items/inherited/new_ids/conflicts）
//   [CONFLICT] <json> exit 3（有歧义且未传 --resolve-new）
//   [FAIL] <原因>     exit 2
import { readFileSync } from "node:fs";

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const ABBR = { cover: "cv", infographic: "ig", "data-chart": "dc", illustration: "il" };

/** 纯函数：designed（无 id 语义条目）+ old（既有 plan 条目）-> 稳定 id/filename 分配结果 */
export function matchAndAssign(designedItems, oldItems = [], { resolveNew = false } = {}) {
  const conflicts = [];
  const ambiguous = new Set(); // L1 多候选索引：不自动继承，冲突报告/强制新建
  const matched = new Array(designedItems.length).fill(null);
  const byHeading = new Map();
  for (const o of oldItems) {
    if (!o.heading) continue;
    if (!byHeading.has(o.heading)) byHeading.set(o.heading, []);
    byHeading.get(o.heading).push(o);
  }

  designedItems.forEach((it, i) => {
    if (it.type === "cover") {
      // L0: cover 天然唯一，直接互认（不依赖 heading）
      matched[i] = oldItems.find((o) => o.type === "cover") ?? null;
      return;
    }
    if (!it.heading) return;
    const avail = (byHeading.get(it.heading) ?? []).filter((o) => o.type === it.type && !matched.includes(o));
    if (avail.length === 1) {
      matched[i] = avail[0];
    } else if (avail.length > 1) {
      conflicts.push({ index: i, heading: it.heading, reason: "heading 多候选", candidates: avail.map((o) => o.id) });
      ambiguous.add(i);
    }
  });

  // L2: 正文条目全部 L1 未命中且数量相等且无歧义 -> 按位继承（数量不等/有歧义一律放弃）
  const bodyIdx = designedItems.map((it, i) => (it.type === "cover" ? -1 : i)).filter((i) => i >= 0);
  const allUnresolved = bodyIdx.every((i) => !matched[i]);
  if (allUnresolved && bodyIdx.length === oldItems.filter((o) => o.type !== "cover").length && conflicts.length === 0) {
    const oldBodies = oldItems.filter((o) => o.type !== "cover");
    bodyIdx.forEach((i, k) => { matched[i] = oldBodies[k]; });
  }

  // 两阶段分配（修复：新建 id 不得抢占后续条目要继承的旧 id）
  const usedIds = new Set();
  const usedFilenames = new Set();
  // 第一遍：确定每个条目的继承身份，登记 usedIds/usedFilenames
  const plan2 = designedItems.map((it, i) => {
    const m = matched[i]
    if (m && m.id && ID_RE.test(m.id) && !usedIds.has(m.id)) {
      usedIds.add(m.id)
      if (m.filename) usedFilenames.add(m.filename)
      return { it, i, m, id: m.id, filename: m.filename || null, isInherited: true }
    }
    return { it, i, m: null, id: null, filename: null, isInherited: false }
  })
  // 第二遍：新建条目分配 id（此时 usedIds 已含全部继承身份，不会撞号）
  const counters = { cover: 0, infographic: 0, "data-chart": 0, illustration: 0 }
  let inherited = 0
  const newIds = []
  const items = plan2.map(({ it, i, m, id, filename, isInherited }) => {
    counters[it.type] += 1
    if (isInherited) {
      inherited += 1
    } else if (ambiguous.has(i)) {
      // 歧义条目：resolveNew=true 时强制新建；否则置 null 由调用方决策
      if (!resolveNew) {
        return { ...it, id: null, filename: null }
      }
      id = nextId(it.type, counters, usedIds)
      filename = it.type === "cover" ? "cover.png" : null
      newIds.push(id)
    } else {
      id = nextId(it.type, counters, usedIds)
      filename = it.type === "cover" ? "cover.png" : null // body filename 由 Compiler 首次分配并锁定
      newIds.push(id)
    }
    usedIds.add(id)
    if (filename) usedFilenames.add(filename)
    return {
      id,
      type: it.type,
      heading: it.heading ?? "",
      concept: it.concept,
      layout: it.layout,
      aspect_ratio: it.aspect_ratio,
      source_facts: Array.isArray(it.source_facts) ? it.source_facts : [],
      ...(filename ? { filename } : {}),
    }
  })

  const unresolvedConflicts = conflicts.filter((c) => items[c.index]?.id === null)
  return { items, inherited, conflicts: unresolvedConflicts, newIds };
}

function nextId(type, counters, usedIds) {
  let id = `${ABBR[type]}-${String(counters[type]).padStart(2, "0")}`;
  while (usedIds.has(id)) {
    counters[type] += 1;
    id = `${ABBR[type]}-${String(counters[type]).padStart(2, "0")}`;
  }
  return id;
}

// ---------- CLI 入口 ----------
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  const argv = process.argv.slice(2);
  const arg = (name, def) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : def;
  };
  const fail = (msg) => { console.log(`[FAIL] ${msg}`); process.exit(2); };
  const newPath = arg("--new");
  if (!newPath) fail("--new 必填（agent 设计语义 JSON：{items:[...]}）");
  let designed;
  try {
    designed = JSON.parse(readFileSync(newPath, "utf8"));
  } catch (e) {
    fail(`new JSON 解析失败: ${e.message}`);
  }
  let old = { items: [] };
  const oldPath = arg("--old");
  if (oldPath) {
    try {
      old = JSON.parse(readFileSync(oldPath, "utf8"));
    } catch {
      old = { items: [] }; // 旧 plan 损坏视为无既有
    }
  }
  const r = matchAndAssign(designed.items ?? [], old.items ?? [], { resolveNew: argv.includes("--resolve-new") });
  const payload = { items: r.items, inherited: r.inherited, new_ids: r.newIds, conflicts: r.conflicts };
  if (r.conflicts.length > 0) {
    console.log(`[CONFLICT] ${JSON.stringify(payload)}`);
    process.exit(3);
  }
  console.log(`[MATCH] ${JSON.stringify(payload)}`);
  process.exit(0);
}
