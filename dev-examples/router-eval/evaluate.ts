/**
 * RP-P1 路由评测器：routing-samples.json 全量回放 → 基线报告（PRD V2 §3.1/§5）
 *
 * 复用共享 dispatch 层（无第二套）；唯一样本库 dev-examples/wx-p1/routing-samples.json。
 * 增强（对比 WX-P1 评测器）：
 *  - 逐字段参数准确率（expectedArgs 逐项比对）
 *  - 路由耗时 p50/p95 + tokens 统计（真实模式）
 *  - Prompt A/B（--prompt A|B，经 IntentRouter.promptBuilder 注入变体）
 *  - 多模型对比（--model + --label，报告按标签落盘可横比）
 *  - 跨 channel 分组准确率（wechat vs cli 行为一致性）
 *  - 模型调用失败 ≠ 合法 unsupported（分计）
 *
 * 用法（仓库根）：
 *   npx tsx dev-examples/router-eval/evaluate.ts --mode fake --label baseline-fake
 *   npx tsx dev-examples/router-eval/evaluate.ts --mode real --label baseline-real
 *   npx tsx dev-examples/router-eval/evaluate.ts --mode real --prompt B --label promptB
 *   npx tsx dev-examples/router-eval/evaluate.ts --mode real --model <spec> --label glm4
 */

import fs from "node:fs";
import path from "node:path";
import type { RoutePlan, WorkflowRegistration } from "../../src/contracts/wx.ts";
import { IntentRouter, type RoutingLLM } from "../../src/dispatch/intent-router.ts";
import { WorkflowRegistry } from "../../src/dispatch/registry.ts";

interface Sample {
  scenario: string;
  channel: string;
  expectedIntent: string;
  expectedAction: string;
  expectedWorkflowId: string | null;
  expectedArgs: Record<string, unknown>;
}

// ── 参数解析 ──

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const mode = argv.includes("--real") || flag("--mode") === "real" ? "real" : "fake";
const model = flag("--model");
const promptVariant = (flag("--prompt") ?? "A").toUpperCase();
const label = flag("--label") ?? `eval-${mode}-prompt${promptVariant}`;
const here = path.dirname(new URL(import.meta.url).pathname);
const SAMPLES_FILE = path.join(here, "..", "wx-p1", "routing-samples.json");
const REGISTRY_FILE = path.join(here, "..", "wx-p1", "registry.json");
const REPORT_DIR = path.join(here, "reports");

// ── Prompt 变体（A/B 评测；A=内置，B=精简规则版无 few-shot） ──

function promptVariantB(text: string, candidates: WorkflowRegistration[]): string {
  const meta = candidates.map((c) => ({
    id: c.workflowId,
    name: c.name,
    required: Object.keys((c.argsSchema as { required?: string[] }).required ?? []),
  }));
  return [
    `用户消息：${text}`,
    `候选：${JSON.stringify(meta)}`,
    '输出 JSON：{"intent":"chat|execute_workflow|clarify|task_control|unsupported","workflowId":候选 id 或 null,"args":{},"missingFields":[],"reason":"","confidence":0~1}',
    "要求：闲聊→chat；查询/取消/列表任务→task_control；能从消息中读出的参数必须填入 args；只输出 JSON。",
  ].join("\n");
}

// ── Fake LLM（关键词确定性，不看 expected 字段） ──

function fakeLlm(registry: WorkflowRegistry): RoutingLLM {
  return {
    async route(prompt) {
      const scenario = prompt.slice("用户消息：".length).split("\n")[0] ?? "";
      const lower = scenario.toLowerCase();
      if (
        /(任务|刚才|取消|停止|列表|进度)/.test(scenario) &&
        !/(分析|翻译|总结|摘要|部署|review|github)/i.test(lower)
      ) {
        return { text: JSON.stringify({ intent: "task_control", reason: "任务控制", confidence: 0.9 }), latencyMs: 1 };
      }
      if (/^(你好|谢谢|哈哈哈|今天天气|你是谁)/.test(scenario)) {
        return { text: JSON.stringify({ intent: "chat", reason: "闲聊", confidence: 0.95 }), latencyMs: 1 };
      }
      const url = scenario.match(/https?:\/\/\S+/)?.[0];
      const pick = /(部署|deploy|发布上线)/.test(scenario)
        ? "deploy-service"
        : /(翻译|translate)/i.test(lower)
          ? "translate"
          : /(总结|摘要|summarize)/i.test(lower)
            ? "summarize"
            : /(分析|评审|review|仓库|github)/i.test(lower)
              ? "github-review"
              : null;
      if (!pick) {
        return { text: JSON.stringify({ intent: "unsupported", reason: "无匹配", confidence: 0.9 }), latencyMs: 1 };
      }
      const argsOut: Record<string, unknown> = {};
      for (const key of (registry.get(pick)?.argsSchema as { required?: string[] }).required ?? []) {
        if (key === "repoUrl" || key === "url") argsOut[key] = url ?? "";
        if (key === "text") argsOut[key] = scenario.match(/[:：]\s*(.+)$/)?.[1]?.trim() ?? "";
        if (key === "targetLang") argsOut[key] = scenario.match(/(中文|英文|日语|English)/)?.[0] ?? "";
      }
      const missing = Object.entries(argsOut)
        .filter(([, v]) => v === "")
        .map(([k]) => k);
      return {
        text: JSON.stringify({
          intent: "execute_workflow",
          workflowId: pick,
          args: argsOut,
          missingFields: missing,
          reason: missing.length ? `缺 ${missing.join(",")}` : "匹配",
          confidence: 0.9,
        }),
        latencyMs: 1,
      };
    },
  };
}

async function realLlm(): Promise<RoutingLLM> {
  const { PiAgentAdapter } = await import("../../src/adapters/pi/pi-agent-adapter.ts");
  const adapter = new PiAgentAdapter({ ...(model ? { defaultModel: model } : {}) });
  return {
    async route(prompt) {
      const started = Date.now();
      let tokens = 0;
      const out = await adapter.run(prompt, {
        label: "router-eval",
        onUsage: (usage) => {
          tokens += usage.total ?? 0;
        },
      });
      return {
        text: out.type === "text" ? out.value : JSON.stringify(out.value),
        latencyMs: Date.now() - started,
        ...(tokens > 0 ? { tokens } : {}),
      };
    },
  };
}

// ── 统计 ──

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

async function main(): Promise<number> {
  const { registry, issues } = WorkflowRegistry.loadFromFile(REGISTRY_FILE);
  if (issues.length) console.warn(`registry 问题条目：${issues.join("; ")}`);
  const llm = mode === "real" ? await realLlm() : fakeLlm(registry);
  const router = new IntentRouter({
    llm,
    registry,
    ...(promptVariant === "B" ? { promptBuilder: promptVariantB } : {}),
  });
  const samples = (JSON.parse(fs.readFileSync(SAMPLES_FILE, "utf-8")) as { samples: Sample[] }).samples;

  let pass = 0;
  let fail = 0;
  let llmFailures = 0;
  const actionConfusion = new Map<string, number>();
  const intentConfusion = new Map<string, number>();
  const fieldStats = new Map<string, { hit: number; total: number }>(); // 逐字段参数
  const channelStats = new Map<string, { pass: number; total: number }>();
  const latencies: number[] = [];
  let tokensTotal = 0;
  const failures: string[] = [];
  const started = Date.now();

  for (const sample of samples) {
    let plan: RoutePlan | null = null;
    try {
      plan = await router.route(sample.scenario);
    } catch {
      llmFailures += 1;
      failures.push(`[LLM失败] ${sample.scenario}`);
      continue;
    }
    if (plan.intent === "unsupported" && /模型调用失败/.test(plan.reason ?? "")) {
      llmFailures += 1;
      failures.push(`[LLM失败] ${sample.scenario}`);
      continue;
    }
    if (plan.latencyMs !== undefined) latencies.push(plan.latencyMs);
    tokensTotal += plan.tokens ?? 0;

    const actionOk = plan.action === sample.expectedAction;
    const wfOk = (plan.workflowId ?? null) === sample.expectedWorkflowId;
    const ok = actionOk && wfOk;
    const aKey = `${sample.expectedAction}→${plan.action}`;
    actionConfusion.set(aKey, (actionConfusion.get(aKey) ?? 0) + 1);
    const iKey = `${sample.expectedIntent}→${plan.intent}`;
    intentConfusion.set(iKey, (intentConfusion.get(iKey) ?? 0) + 1);
    const ch = channelStats.get(sample.channel) ?? { pass: 0, total: 0 };
    ch.total += 1;
    if (ok) ch.pass += 1;
    channelStats.set(sample.channel, ch);

    // 逐字段参数准确率（执行类样本 & 目标命中时）
    if (
      sample.expectedAction === "start_execution" &&
      plan.action === "start_execution" &&
      plan.workflowId === sample.expectedWorkflowId
    ) {
      for (const [field, expected] of Object.entries(sample.expectedArgs ?? {})) {
        const stat = fieldStats.get(field) ?? { hit: 0, total: 0 };
        stat.total += 1;
        const actual = plan.args?.[field];
        if (actual !== undefined && String(actual) === String(expected)) stat.hit += 1;
        fieldStats.set(field, stat);
      }
    }
    if (ok) {
      pass += 1;
    } else {
      fail += 1;
      failures.push(
        `[判定失败] ${sample.scenario} → 期望 ${sample.expectedAction}/${sample.expectedWorkflowId ?? "-"}，实际 ${plan.action}/${plan.workflowId ?? "-"}（${plan.reason ?? ""}）`,
      );
    }
  }

  const judged = pass + fail;
  const accuracy = judged > 0 ? pass / judged : 0;
  const sortedLat = [...latencies].sort((a, b) => a - b);
  const fieldReport = Object.fromEntries(
    [...fieldStats.entries()].map(([f, s]) => [
      f,
      { hit: s.hit, total: s.total, accuracy: s.total > 0 ? s.hit / s.total : 0 },
    ]),
  );

  const report = {
    label,
    mode,
    promptVariant,
    ...(model ? { model } : { model: "(default: ~/.pi/agent/settings.json)" }),
    at: new Date().toISOString(),
    samples: samples.length,
    judged,
    pass,
    fail,
    llmFailures,
    accuracy,
    gate: ">=90%",
    confusion: {
      action: Object.fromEntries([...actionConfusion.entries()].sort()),
      intent: Object.fromEntries([...intentConfusion.entries()].sort()),
    },
    perFieldArgs: fieldReport,
    byChannel: Object.fromEntries(
      [...channelStats.entries()].map(([c, s]) => [
        c,
        { pass: s.pass, total: s.total, accuracy: s.total > 0 ? s.pass / s.total : 0 },
      ]),
    ),
    latency: {
      meanMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
      p50Ms: percentile(sortedLat, 50),
      p95Ms: percentile(sortedLat, 95),
    },
    tokens: { total: tokensTotal, mean: latencies.length ? Math.round(tokensTotal / samples.length) : 0 },
    durationMs: Date.now() - started,
    failures: failures.slice(0, 30),
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const jsonFile = path.join(REPORT_DIR, `${label}.json`);
  fs.writeFileSync(jsonFile, JSON.stringify(report, null, 2), "utf-8");

  const md = [
    `# 路由评测报告：${label}`,
    "",
    `- 模式：${mode} · Prompt：${promptVariant} · 模型：${report.model}`,
    `- 样本 ${samples.length}（wechat ${channelStats.get("wechat")?.total ?? 0} / cli ${channelStats.get("cli")?.total ?? 0}）· 判定 ${judged} · LLM 失败 ${llmFailures}`,
    `- **准确率：${(accuracy * 100).toFixed(1)}%（Gate ≥90%：${accuracy >= 0.9 ? "PASS" : "FAIL"}）**`,
    `- 耗时：mean ${report.latency.meanMs}ms / p50 ${report.latency.p50Ms}ms / p95 ${report.latency.p95Ms}ms · tokens ${tokensTotal}`,
    "",
    "## 混淆（action）",
    ...[...actionConfusion.entries()].sort().map(([k, v]) => `- ${k}: ${v}`),
    "",
    "## 逐字段参数准确率",
    ...Object.entries(fieldReport).map(([f, s]) => `- ${f}: ${(s.accuracy * 100).toFixed(0)}%（${s.hit}/${s.total}）`),
    "",
    "## 跨 channel",
    ...Object.entries(report.byChannel).map(
      ([c, s]) => `- ${c}: ${(s.accuracy * 100).toFixed(1)}%（${s.pass}/${s.total}）`,
    ),
    "",
    ...(failures.length ? ["## 失败明细", ...failures.slice(0, 30).map((f) => `- ${f}`)] : []),
  ].join("\n");
  fs.writeFileSync(path.join(REPORT_DIR, `${label}.md`), md, "utf-8");

  console.log(`label=${label} 模式=${mode} prompt=${promptVariant}`);
  console.log(
    `准确率=${(accuracy * 100).toFixed(1)}%（${pass}/${judged}）LLM失败=${llmFailures} gate=${accuracy >= 0.9 ? "PASS" : "FAIL"}`,
  );
  console.log(
    `逐字段：${Object.entries(fieldReport)
      .map(([f, s]) => `${f} ${(s.accuracy * 100).toFixed(0)}%`)
      .join(" ")}`,
  );
  console.log(
    `耗时 mean/p50/p95 = ${report.latency.meanMs}/${report.latency.p50Ms}/${report.latency.p95Ms}ms，tokens=${tokensTotal}`,
  );
  console.log(`报告：${jsonFile}`);
  return accuracy >= 0.9 && llmFailures === 0 ? 0 : 1;
}

main().then(
  (c) => {
    process.exitCode = c;
  },
  (e) => {
    console.error(`❌ ${e instanceof Error ? e.stack : String(e)}`);
    process.exitCode = 1;
  },
);
