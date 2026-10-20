/**
 * WX-P1 评测器：routing-samples.json 全量回放 → 准确率/混淆矩阵/逐字段统计
 * 双模式：--mode fake（关键词假 LLM，不花 token）/ --mode real（PiAgentAdapter 真实 LLM）
 * 判定口径：expectedAction + expectedWorkflowId；模型调用失败≠合法 unsupported（分开统计）
 *
 * 运行（仓库根）：
 *   npx tsx dev-examples/wx-p1/evaluate.ts --mode fake
 *   npx tsx dev-examples/wx-p1/evaluate.ts --mode real --model cc-switch-zhipu-glm/glm-5.3-flash
 */

import fs from "node:fs";
import path from "node:path";
import { WorkflowRegistry } from "../../src/dispatch/registry.ts";
import { IntentRouter, type RoutingLLM } from "../../src/dispatch/intent-router.ts";
import type { RoutePlan } from "../../src/contracts/wx.ts";

interface Sample {
  scenario: string;
  channel: string;
  expectedIntent: string;
  expectedAction: string;
  expectedWorkflowId: string | null;
  expectedArgs: Record<string, unknown>;
}

const args = process.argv.slice(2);
const mode = args.includes("--fake") || args.includes("--mode", 0) === false ? (args.includes("--real") ? "real" : "fake") : "fake";
const modelFlag = args.indexOf("--model");
const model = modelFlag >= 0 ? args[modelFlag + 1] : undefined;
const here = path.dirname(new URL(import.meta.url).pathname);

/** Fake LLM：独立关键词映射（不看 expected 字段，验证链路与计数） */
function fakeLlm(registry: WorkflowRegistry): RoutingLLM {
  return {
    async route(prompt) {
      const scenario = prompt.slice("用户消息：".length).split("\n")[0] ?? "";
      const lower = scenario.toLowerCase();
      const taskControl = /(任务|刚才|取消|停止|列表)/.test(scenario) && !/(分析|翻译|总结|摘要|部署|review|github)/i.test(lower);
      if (taskControl) {
        return { text: JSON.stringify({ intent: "task_control", reason: "任务控制", confidence: 0.9 }), latencyMs: 1 };
      }
      const chatOnly = /^(你好|谢谢|哈哈哈|今天天气|你是谁)/.test(scenario);
      if (chatOnly) {
        return { text: JSON.stringify({ intent: "chat", reason: "闲聊", confidence: 0.95 }), latencyMs: 1 };
      }
      // 工作流匹配：url/text 参数抽取
      const url = scenario.match(/https?:\/\/\S+/)?.[0];
      const translate = /(翻译|translate)/i.test(lower);
      const summarize = /(总结|摘要|summarize)/i.test(lower);
      const review = /(分析|评审|review|仓库|github)/i.test(lower);
      const deploy = /(部署|deploy|发布上线)/.test(scenario);
      const pick = deploy ? "deploy-service" : translate ? "translate" : summarize ? "summarize" : review ? "github-review" : null;
      if (!pick) {
        return { text: JSON.stringify({ intent: "unsupported", reason: "无匹配流程", confidence: 0.9 }), latencyMs: 1 };
      }
      const argsOut: Record<string, unknown> = {};
      const reg = registry.get(pick);
      for (const key of ((reg?.argsSchema as { required?: string[] }).required ?? [])) {
        if (key === "repoUrl" || key === "url") argsOut[key] = url ?? "";
        if (key === "text") argsOut[key] = extractQuoted(scenario) ?? "";
        if (key === "targetLang") argsOut[key] = scenario.match(/(中文|英文|日语|English)/)?.[0] ?? "";
      }
      const missing = Object.entries(argsOut).filter(([, v]) => v === "").map(([k]) => k);
      if (missing.length > 0) {
        return {
          text: JSON.stringify({ intent: "execute_workflow", workflowId: pick, args: argsOut, missingFields: missing, reason: `缺 ${missing.join(",")}`, confidence: 0.9 }),
          latencyMs: 1,
        };
      }
      return {
        text: JSON.stringify({ intent: "execute_workflow", workflowId: pick, args: argsOut, reason: "匹配", confidence: 0.9 }),
        latencyMs: 1,
      };
    },
  };
}

function extractQuoted(text: string): string | undefined {
  const cn = text.match(/[:：]\s*(.+)$/);
  if (cn?.[1]) return cn[1].trim();
  const en = text.match(/[:：]\s*(.+)$/);
  return en?.[1]?.trim();
}

async function realLlm(): Promise<RoutingLLM> {
  const { PiAgentAdapter } = await import("../../src/adapters/pi/pi-agent-adapter.ts");
  const adapter = new PiAgentAdapter({ ...(model ? { defaultModel: model } : {}) });
  const started = Date.now();
  return {
    async route(prompt) {
      const out = await adapter.run(prompt, { label: "router", timeoutMs: 60_000 });
      return { text: out.value, latencyMs: Date.now() - started };
    },
  };
}

async function main(): Promise<number> {
  const { registry, issues } = WorkflowRegistry.loadFromFile(path.join(here, "registry.json"));
  if (issues.length) console.log(`registry 加载问题：${issues.join("; ")}`);
  const llm = mode === "real" ? await realLlm() : fakeLlm(registry);
  const router = new IntentRouter({ llm, registry });
  const samples = (JSON.parse(fs.readFileSync(path.join(here, "routing-samples.json"), "utf-8")) as { samples: Sample[] }).samples;

  const confusion = new Map<string, number>();
  let pass = 0;
  let fail = 0;
  let llmFailures = 0;
  const failures: string[] = [];
  const started = Date.now();

  for (const sample of samples) {
    let plan: RoutePlan;
    try {
      plan = await router.route(sample.scenario);
    } catch (e) {
      llmFailures += 1;
      failures.push(`[LLM失败] ${sample.scenario} → ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (plan.intent === "unsupported" && /模型调用失败/.test(plan.reason ?? "")) {
      llmFailures += 1;
      failures.push(`[LLM失败] ${sample.scenario}`);
      continue;
    }
    const actionOk = plan.action === sample.expectedAction;
    const wfOk = (plan.workflowId ?? null) === sample.expectedWorkflowId;
    const key = `${sample.expectedAction}→${plan.action}`;
    confusion.set(key, (confusion.get(key) ?? 0) + 1);
    if (actionOk && wfOk) {
      pass += 1;
    } else {
      fail += 1;
      failures.push(`[判定失败] ${sample.scenario} → 期望 ${sample.expectedAction}/${sample.expectedWorkflowId}，实际 ${plan.action}/${plan.workflowId ?? null}（${plan.reason ?? ""}）`);
    }
  }

  const total = pass + fail;
  const accuracy = total > 0 ? pass / total : 0;
  console.log(`模式=${mode} 样本=${samples.length} 判定=${total} 通过=${pass} 失败=${fail} LLM失败=${llmFailures}`);
  console.log(`准确率（判定口径，不含 LLM 失败）= ${(accuracy * 100).toFixed(1)}%（Gate ≥90%）`);
  console.log("混淆（期望action→实际action）：");
  for (const [k, v] of [...confusion.entries()].sort()) console.log(`  ${k}: ${v}`);
  if (failures.length > 0) {
    console.log("失败明细：");
    for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
  }
  const report = {
    mode,
    at: new Date().toISOString(),
    samples: samples.length,
    pass,
    fail,
    llmFailures,
    accuracy,
    confusion: Object.fromEntries(confusion),
    failures,
    durationMs: Date.now() - started,
  };
  const reportFile = path.join(here, `eval-report-${mode}.json`);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), "utf-8");
  console.log(`报告落盘：${reportFile}`);
  return accuracy >= 0.9 && llmFailures === 0 ? 0 : 1;
}

main().then(
  (c) => (process.exitCode = c),
  (e) => {
    console.error(`❌ ${e instanceof Error ? e.stack : String(e)}`);
    process.exitCode = 1;
  },
);
