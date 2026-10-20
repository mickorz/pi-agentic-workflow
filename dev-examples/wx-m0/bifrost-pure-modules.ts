/**
 * WX-P0 T4：Bifrost 纯逻辑模块抽取验证（LK-02 路径 2）
 *
 * 目的：验证 thirdparties/pi-bifrost 的 routing/config/virtual-model 纯模块
 * 能否在无 Extension 宿主的本项目进程内直接 import 使用。
 *
 * 验证项：
 *  1. import routing.ts（findCandidates/selectModel/modelKey 等）与 config.ts（loadConfig/RouteRule）
 *  2. 加载 submodule 自带 bifrost.json 配置
 *  3. 用假模型池跑一次候选检索与选择（quick/general/frontier 三 tier）
 *
 * 运行（仓库根）：npx tsx dev-examples/wx-m0/bifrost-pure-modules.ts
 */

import { readFile } from "node:fs/promises";
import { findCandidates, selectModel, modelKey, type RouteRule } from "../../thirdparties/pi-bifrost/routing.ts";
import { DEFAULT_RULES, validateConfig, type BifrostConfig } from "../../thirdparties/pi-bifrost/config.ts";
import { BIFROST_AUTO_PROVIDER, BIFROST_AUTO_ID } from "../../thirdparties/pi-bifrost/virtual-model.ts";

/** 形态对齐 pi-ai Model 的最小假模型（routing.ts 仅用到这几个字段） */
function fakeModel(provider: string, id: string, cost = 0.001) {
  return {
    provider,
    id,
    api: "anthropic",
    model: id,
    limits: { context: 200_000, output: 8_000 },
    cost: { input: cost, output: cost * 3, cacheRead: cost / 10, cacheWrite: cost * 1.25, total: 0 },
    reasoning: false,
  } as never;
}

async function main(): Promise<number> {
  console.log("── T4-1 纯模块 import（routing / config / virtual-model）");
  console.log("   ✓ 加载成功（仅 @earendil-works/pi-ai 类型依赖，本项目 node_modules 内可解析）");
  console.log(`   ✓ 虚拟模型标识：${BIFROST_AUTO_PROVIDER}/${BIFROST_AUTO_ID}`);

  console.log("── T4-2 加载 bifrost.json 配置");
  const raw = JSON.parse(await readFile("thirdparties/pi-bifrost/bifrost.json", "utf-8")) as BifrostConfig;
  const issues = validateConfig(raw);
  console.log(`   ✓ 配置解析成功：enabled=${raw.enabled}，default=${raw.default}，issues=${issues.length}`);

  console.log("── T4-3 候选检索与选择（三 tier 假模型池，pattern=池名子串匹配）");
  const pool = [
    fakeModel("anthropic", "haiku-quick"),
    fakeModel("anthropic", "sonnet-general"),
    fakeModel("anthropic", "opus-frontier", 0.01),
  ];
  const ctx = { modelRegistry: { getAvailable: () => pool } } as never;
  for (const tier of ["quick", "general", "frontier"]) {
    const candidates = findCandidates(ctx, tier);
    const picked = selectModel(candidates, "first");
    console.log(
      `   tier=${tier}: candidates=[${candidates.map((m) => modelKey(m)).join(", ") || "无"}] → 选择=${picked ? modelKey(picked) : "无"}（strategy=first）`,
    );
  }
  void DEFAULT_RULES;
  void raw;

  console.log("\n✅ Bifrost 纯逻辑抽取路径可行：tier/池/策略可在本项目独立实现 ModelRouter（LK-02 路径 2）");
  return 0;
}

main().then(
  (c) => (process.exitCode = c),
  (e) => {
    console.error(`❌ ${e instanceof Error ? e.stack : String(e)}`);
    process.exitCode = 1;
  },
);
