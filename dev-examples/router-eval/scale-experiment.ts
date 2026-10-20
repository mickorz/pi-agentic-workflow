/**
 * RP-P3 规模与算法实验：候选规模 3→10→30→100 × 检索策略（keyword / bm25 / all）
 * 产出：准确率/延迟/tokens/提示词长度曲线 + 检索升级建议（供 IR-010 决策）
 *
 * 设计（PRD V2 §3.1/§6-P3）：
 *  - 基座 3 个真实工作流（github-review/translate/summarize）+ 97 个合成干扰项 → 规模阶梯
 *  - 基座样本 8 条（样本库抽取）：测干扰抵抗 + 检索召回
 *  - 针样本 4 条（只指向干扰项）：N=3 时应正确拒绝；干扰项入表后应命中（测大海捞针）
 *  - 策略经包装 registry.search 注入（IntentRouter 零改动，白名单校验同路径）
 *
 * 用法（仓库根）：
 *   npx tsx dev-examples/router-eval/scale-experiment.ts --mode fake     # 管线自检
 *   npx tsx dev-examples/router-eval/scale-experiment.ts --mode real     # 真实数据（~112 次调用）
 */

import fs from "node:fs";
import path from "node:path";
import type { RoutePlan, WorkflowRegistration } from "../../src/contracts/wx.ts";
import { IntentRouter, type RoutingLLM } from "../../src/dispatch/intent-router.ts";
import { WorkflowRegistry } from "../../src/dispatch/registry.ts";

const argv = process.argv.slice(2);
const modeFlag = argv.indexOf("--mode");
const mode = argv.includes("--real") || (modeFlag >= 0 && argv[modeFlag + 1] === "real") ? "real" : "fake";
const SCALES = [3, 10, 30, 100];
const ALL_STRATEGY_MAX_SCALE = 10; // all 策略仅在 ≤10 跑（100 候选提示词过长即结论本身）
const TOP_K = 8;
const here = path.dirname(new URL(import.meta.url).pathname);

// ── 基座工作流（wx-p1 registry 同元数据） ──

const BASE: WorkflowRegistration[] = [
  {
    workflowId: "github-review",
    scriptPath: "github-review.js",
    name: "GitHub 仓库分析",
    description: "分析 GitHub 仓库并输出评审报告",
    argsSchema: { type: "object", properties: { repoUrl: { type: "string" } }, required: ["repoUrl"] },
    riskLevel: "read-only",
    enabled: true,
    keywords: ["分析", "评审", "review", "github", "仓库"],
  },
  {
    workflowId: "translate",
    scriptPath: "translate.js",
    name: "文本翻译",
    description: "把一段文本翻译到目标语言",
    argsSchema: {
      type: "object",
      properties: { text: { type: "string" }, targetLang: { type: "string" } },
      required: ["text", "targetLang"],
    },
    riskLevel: "read-only",
    enabled: true,
    keywords: ["翻译", "translate"],
  },
  {
    workflowId: "summarize",
    scriptPath: "summarize.js",
    name: "链接摘要",
    description: "总结一个网页链接的内容",
    argsSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    riskLevel: "read-only",
    enabled: true,
    keywords: ["总结", "摘要", "summarize", "文章", "网页"],
  },
];

// ── 干扰项池（97 个；前 4 个为针样本目标） ──

interface DistractorSpec {
  id: string;
  name: string;
  description: string;
  keywords: string[];
}

const DISTRACTORS: DistractorSpec[] = [
  {
    id: "d-expense-claim",
    name: "差旅报销",
    description: "提交差旅与发票报销单并走审批流",
    keywords: ["报销", "发票", "差旅", "费用"],
  },
  {
    id: "d-bulk-email",
    name: "邮件群发",
    description: "给员工或客户批量发送通知邮件",
    keywords: ["邮件", "群发", "通知", "发送"],
  },
  {
    id: "d-db-backup",
    name: "数据库备份",
    description: "把生产数据库备份到异地存储",
    keywords: ["备份", "数据库", "存储"],
  },
  {
    id: "d-weekly-report",
    name: "经营周报",
    description: "汇总经营数据生成本周周报",
    keywords: ["周报", "经营", "汇报"],
  },
  { id: "d-attendance", name: "考勤统计", description: "统计员工打卡与加班考勤", keywords: ["考勤", "打卡", "加班"] },
  {
    id: "d-invoice-check",
    name: "发票核验",
    description: "批量核验增值税发票真伪",
    keywords: ["发票", "核验", "真伪"],
  },
  { id: "d-oncall", name: "值班排班", description: "生成运维值班排班表", keywords: ["值班", "排班", "运维"] },
  {
    id: "d-cr-monitor",
    name: "代码合并监控",
    description: "监控合并请求状态并提醒评审",
    keywords: ["合并", "监控", "评审"],
  },
  {
    id: "d-doc-sync",
    name: "文档同步",
    description: "在 Confluence 与语雀间同步文档",
    keywords: ["文档", "同步", "confluence"],
  },
  { id: "d-log-clean", name: "日志清理", description: "按保留策略清理过期日志", keywords: ["日志", "清理", "过期"] },
  { id: "d-price-watch", name: "价格监控", description: "监控竞品价格变动并告警", keywords: ["价格", "监控", "竞品"] },
  { id: "d-seo-audit", name: "SEO 体检", description: "对站点做 SEO 健康检查", keywords: ["seo", "体检", "站点"] },
  {
    id: "d-domain-cert",
    name: "证书续期",
    description: "检查并续期域名 TLS 证书",
    keywords: ["证书", "域名", "续期", "tls"],
  },
  {
    id: "d-assets-inv",
    name: "资产盘点",
    description: "盘点公司固定资产并生成清单",
    keywords: ["资产", "盘点", "清单"],
  },
  { id: "d-meeting-note", name: "会议纪要", description: "录音转写并生成会议纪要", keywords: ["会议", "纪要", "转写"] },
  {
    id: "d-resume-screen",
    name: "简历筛选",
    description: "批量筛选候选人简历并打分",
    keywords: ["简历", "筛选", "招聘"],
  },
  {
    id: "d-contract-due",
    name: "合同到期提醒",
    description: "扫描合同台账并提醒到期续签",
    keywords: ["合同", "到期", "提醒"],
  },
  {
    id: "d-kb-search",
    name: "知识库问答",
    description: "基于内部知识库回答员工提问",
    keywords: ["知识库", "问答", "内部"],
  },
  { id: "d-form-gen", name: "表单生成", description: "按字段清单生成收集表单", keywords: ["表单", "生成", "收集"] },
  { id: "d-sms-notify", name: "短信通知", description: "按模板批量发送短信通知", keywords: ["短信", "通知", "模板"] },
  {
    id: "d-ci-trigger",
    name: "流水线触发",
    description: "手动触发 CI 流水线并回报状态",
    keywords: ["流水线", "ci", "触发"],
  },
  {
    id: "d-release-note",
    name: "发布说明",
    description: "根据提交记录生成发布说明",
    keywords: ["发布", "说明", "changelog"],
  },
  { id: "d-bug-triage", name: "缺陷分诊", description: "对新缺陷自动分级并指派", keywords: ["缺陷", "分诊", "bug"] },
  { id: "d-perf-test", name: "压测执行", description: "对目标服务发起压力测试", keywords: ["压测", "性能", "测试"] },
  {
    id: "d-data-clean",
    name: "数据清洗",
    description: "按规则清洗脏数据并输出报告",
    keywords: ["数据", "清洗", "脏数据"],
  },
];
// 扩展到 97：同域变体（保持 kebab id 与独特关键词组合）
const VARIANTS = ["华东", "华南", "华北", "海外", "零售", "电商", "金融", "制造", "教育", "医疗", "物流", "行政"];
for (let i = 0; DISTRACTORS.length < 97; i += 1) {
  const src = DISTRACTORS[i % 25];
  const v = VARIANTS[Math.floor(i / 25) % VARIANTS.length];
  if (!src || !v) continue;
  const n = DISTRACTORS.length + 1;
  DISTRACTORS.push({
    id: `${src.id}-v${n}`,
    name: `${src.name}（${v}）`,
    description: `${src.description}（${v}专线）`,
    keywords: [...src.keywords, v],
  });
}

function distractorRegistration(spec: DistractorSpec): WorkflowRegistration {
  return {
    workflowId: spec.id,
    scriptPath: "noop.js",
    name: spec.name,
    description: spec.description,
    argsSchema: { type: "object", properties: {}, required: [] },
    riskLevel: "read-only",
    enabled: true,
    keywords: spec.keywords,
  };
}

// ── 样本 ──

interface Probe {
  scenario: string;
  kind: "base" | "needle";
  expectedWorkflowId: string; // needle 目标 = 干扰项 id
  expectedArgs?: Record<string, unknown>;
}

const BASE_PROBES: Probe[] = [
  {
    scenario: "分析 https://github.com/o/r",
    kind: "base",
    expectedWorkflowId: "github-review",
    expectedArgs: { repoUrl: "https://github.com/o/r" },
  },
  { scenario: "帮我 review 这个仓库 https://github.com/a/b", kind: "base", expectedWorkflowId: "github-review" },
  { scenario: "把 Hello world 翻译成中文", kind: "base", expectedWorkflowId: "translate" },
  { scenario: "翻译成英文：今天天气不错", kind: "base", expectedWorkflowId: "translate" },
  { scenario: "帮我把这段话 translate 成日语：早上好", kind: "base", expectedWorkflowId: "translate" },
  { scenario: "总结这个网页 https://example.com/a", kind: "base", expectedWorkflowId: "summarize" },
  { scenario: "给我一个这篇 https://example.com/b 文章的摘要", kind: "base", expectedWorkflowId: "summarize" },
  { scenario: "分析一下 https://github.com/x/y 仓库有什么问题", kind: "base", expectedWorkflowId: "github-review" },
];

const NEEDLE_PROBES: Probe[] = [
  { scenario: "帮我把上个月的差旅发票报销了", kind: "needle", expectedWorkflowId: "d-expense-claim" },
  { scenario: "给全体员工群发一封年会通知邮件", kind: "needle", expectedWorkflowId: "d-bulk-email" },
  { scenario: "把生产数据库备份到异地存储", kind: "needle", expectedWorkflowId: "d-db-backup" },
  { scenario: "汇总数据生成本周经营周报", kind: "needle", expectedWorkflowId: "d-weekly-report" },
];

// ── 检索策略 ──

type Strategy = "keyword" | "bm25" | "all";

function tokenize(text: string): string[] {
  const latin = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const cjk = text.match(/[\u4e00-\u9fff]/g) ?? [];
  return [...latin, ...cjk];
}

/** BM25（k1=1.5, b=0.75）：文档 = name+description+keywords+id 分词 */
function bm25Search(query: string, docs: WorkflowRegistration[], topK = TOP_K): WorkflowRegistration[] {
  const q = tokenize(query);
  const k1 = 1.5;
  const b = 0.75;
  const docTokens = docs.map((d) => tokenize([d.name, d.description, d.keywords.join(" "), d.workflowId].join(" ")));
  const avgDl = docTokens.reduce((a, t) => a + t.length, 0) / (docs.length || 1);
  const df = new Map<string, number>();
  for (const tokens of docTokens) {
    for (const term of new Set(tokens)) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const scored = docs.map((doc, i) => {
    const tokens = docTokens[i] ?? [];
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const term of q) {
      const f = tf.get(term);
      if (!f) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * tokens.length) / (avgDl || 1))));
    }
    return { doc, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, topK)
    .map((s) => s.doc);
}

/** 策略包装 registry（IntentRouter 依赖结构类型 {search,get}，零改动注入） */
class StrategyRegistry {
  constructor(
    private readonly inner: WorkflowRegistry,
    private readonly strategy: Strategy,
  ) {}
  search(text: string, limit = TOP_K): WorkflowRegistration[] {
    const all = this.inner.all();
    if (this.strategy === "all") return all.slice(0, 100);
    if (this.strategy === "bm25") return bm25Search(text, all, limit);
    return this.inner.search(text, limit);
  }
  get(id: string): WorkflowRegistration | undefined {
    return this.inner.get(id);
  }
}

// ── LLM ──

function fakeLlm(getWorkflow: (id: string) => WorkflowRegistration | undefined): RoutingLLM {
  return {
    async route(prompt) {
      const scenario = prompt.slice("用户消息：".length).split("\n")[0] ?? "";
      const lower = scenario.toLowerCase();
      const url = scenario.match(/https?:\/\/\S+/)?.[0];
      // 与真实 LLM 同构的判定职责：从「候选清单」里选（提示词 JSON 中列出的 workflowId）
      const ids = [...prompt.matchAll(/"workflowId":\s*"([^"]+)"/g)].map((m) => m[1]);
      const hit =
        ids.includes("github-review") && /(分析|评审|review|仓库|github)/i.test(lower)
          ? "github-review"
          : ids.includes("translate") && /(翻译|translate)/i.test(lower)
            ? "translate"
            : ids.includes("summarize") && /(总结|摘要|summarize|文章|网页)/i.test(lower)
              ? "summarize"
              : (ids.find((id) => id.startsWith("d-") && getWorkflow(id)?.keywords.some((k) => scenario.includes(k))) ??
                null);
      if (!hit)
        return {
          text: JSON.stringify({ intent: "unsupported", reason: "候选中无匹配", confidence: 0.9 }),
          latencyMs: 1,
        };
      const argsOut: Record<string, unknown> = {};
      for (const key of (getWorkflow(hit)?.argsSchema as { required?: string[] } | undefined)?.required ?? []) {
        if (key === "repoUrl" || key === "url") argsOut[key] = url ?? "";
        if (key === "text") argsOut[key] = scenario.match(/[:：]\s*(.+)$/)?.[1]?.trim() ?? "x";
        if (key === "targetLang") argsOut[key] = scenario.match(/(中文|英文|日语|English)/)?.[0] ?? "x";
      }
      return {
        text: JSON.stringify({
          intent: "execute_workflow",
          workflowId: hit,
          args: argsOut,
          missingFields: [],
          reason: "匹配",
          confidence: 0.9,
        }),
        latencyMs: 1,
      };
    },
  };
}

async function realLlmFactory(): Promise<RoutingLLM> {
  const { PiAgentAdapter } = await import("../../src/adapters/pi/pi-agent-adapter.ts");
  const adapter = new PiAgentAdapter({});
  return {
    async route(prompt) {
      const started = Date.now();
      let tokens = 0;
      const out = await adapter.run(prompt, {
        label: "scale-exp",
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

// ── 主流程 ──

interface Cell {
  scale: number;
  strategy: Strategy;
  baseTotal: number;
  baseHit: number;
  needleTotal: number;
  needleHit: number;
  needleCorrectReject: number; // N=3 无目标时的正确拒绝
  recallBase: number; // 检索层：期望 wf 是否进候选
  latencyMeanMs: number;
  tokensMean: number;
  promptCharsMean: number;
}

async function runCell(
  scale: number,
  strategy: Strategy,
  llmFactory: (registry: WorkflowRegistry) => RoutingLLM,
): Promise<Cell> {
  const regs = [...BASE, ...DISTRACTORS.slice(0, scale - 3).map(distractorRegistration)];
  const registry = new WorkflowRegistry(regs);
  const wrapped = new StrategyRegistry(registry, strategy);
  const router = new IntentRouter({ llm: llmFactory(registry), registry: wrapped });

  const cell: Cell = {
    scale,
    strategy,
    baseTotal: 0,
    baseHit: 0,
    needleTotal: 0,
    needleHit: 0,
    needleCorrectReject: 0,
    recallBase: 0,
    latencyMeanMs: 0,
    tokensMean: 0,
    promptCharsMean: 0,
  };
  const latencies: number[] = [];
  let tokensSum = 0;
  let promptCharsSum = 0;
  let n = 0;

  // 检索层召回（不经 LLM）
  let recallHit = 0;
  for (const p of BASE_PROBES) {
    if (wrapped.search(p.scenario).some((c) => c.workflowId === p.expectedWorkflowId)) recallHit += 1;
  }
  cell.recallBase = recallHit / BASE_PROBES.length;

  const probe = async (p: Probe) => {
    // 提示词长度按策略实测（重建同构提示词）
    const candidates = wrapped.search(p.scenario);
    promptCharsSum += JSON.stringify(candidates.map((c) => c.workflowId)).length + p.scenario.length;
    const plan: RoutePlan = await router.route(p.scenario);
    if (process.env.DEBUG_PLANS)
      console.log(
        `  [dbg] ${p.scenario} → ${plan.intent}/${plan.action}/${plan.workflowId ?? "-"}（${plan.reason ?? ""}）`,
      );
    if (plan.latencyMs !== undefined) latencies.push(plan.latencyMs);
    tokensSum += plan.tokens ?? 0;
    n += 1;
    const targetPresent = registry.get(p.expectedWorkflowId) !== undefined;
    if (p.kind === "base") {
      cell.baseTotal += 1;
      if (plan.action === "start_execution" && plan.workflowId === p.expectedWorkflowId) cell.baseHit += 1;
    } else {
      cell.needleTotal += 1;
      if (targetPresent) {
        if (plan.action === "start_execution" && plan.workflowId === p.expectedWorkflowId) cell.needleHit += 1;
      } else if (plan.action !== "start_execution") {
        cell.needleCorrectReject += 1;
      }
    }
  };

  for (const p of BASE_PROBES) await probe(p);
  for (const p of NEEDLE_PROBES) await probe(p);

  cell.latencyMeanMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  cell.tokensMean = n ? Math.round(tokensSum / n) : 0;
  cell.promptCharsMean = n ? Math.round(promptCharsSum / n) : 0;
  return cell;
}

async function main(): Promise<number> {
  const realLlmCached = await realLlmFactory();
  const llmFactory =
    mode === "real" ? () => realLlmCached : (registry: WorkflowRegistry) => fakeLlm((id) => registry.get(id));
  const cells: Cell[] = [];
  const started = Date.now();
  for (const scale of SCALES) {
    for (const strategy of ["keyword", "bm25", ...(scale <= ALL_STRATEGY_MAX_SCALE ? ["all"] : [])] as Strategy[]) {
      const cell = await runCell(scale, strategy, llmFactory);
      cells.push(cell);
      const acc = (cell.baseHit + cell.needleHit + cell.needleCorrectReject) / (cell.baseTotal + cell.needleTotal);
      console.log(
        `N=${String(scale).padStart(3)} ${strategy.padEnd(7)} base ${cell.baseHit}/${cell.baseTotal} needle ${cell.needleHit}/${cell.needleTotal} 拒绝 ${cell.needleCorrectReject}/${cell.needleTotal} 召回 ${(cell.recallBase * 100).toFixed(0)}% 总准确 ${(acc * 100).toFixed(0)}% 延迟 ${cell.latencyMeanMs}ms tokens ${cell.tokensMean}`,
      );
    }
  }

  const report = {
    mode,
    at: new Date().toISOString(),
    durationMs: Date.now() - started,
    config: {
      scales: SCALES,
      topK: TOP_K,
      allMaxScale: ALL_STRATEGY_MAX_SCALE,
      baseProbes: BASE_PROBES.length,
      needleProbes: NEEDLE_PROBES.length,
    },
    cells,
  };
  const reportDir = path.join(here, "reports");
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, `scale-${mode}.json`), JSON.stringify(report, null, 2), "utf-8");

  // MD 摘要
  const rows = cells.map((c) => {
    const acc = (c.baseHit + c.needleHit + c.needleCorrectReject) / (c.baseTotal + c.needleTotal);
    return `| ${c.scale} | ${c.strategy} | ${(c.recallBase * 100).toFixed(0)}% | ${c.baseHit}/${c.baseTotal} | ${c.needleHit}/${c.needleTotal} | ${c.needleCorrectReject}/${c.needleTotal} | ${(acc * 100).toFixed(0)}% | ${c.latencyMeanMs} | ${c.tokensMean} |`;
  });
  const md = [
    `# 规模与检索实验（${mode}）`,
    "",
    `执行 ${new Date().toISOString()} · 耗时 ${Math.round(report.durationMs / 1000)}s`,
    "",
    "| N | 策略 | 基座召回@8 | 基座命中 | 针命中 | 针正确拒绝 | 总准确 | 延迟mean | tokens/次 |",
    "|---|------|-----------|---------|--------|-----------|--------|---------|----------|",
    ...rows,
    "",
    "## 解读（自动生成要点）",
    ...autoFindings(cells),
  ].join("\n");
  fs.writeFileSync(path.join(reportDir, `scale-${mode}.md`), md, "utf-8");
  console.log(`报告：${path.join(reportDir, `scale-${mode}.json`)}`);
  return 0;
}

function autoFindings(cells: Cell[]): string[] {
  const out: string[] = [];
  const at = (scale: number, strategy: Strategy) => cells.find((c) => c.scale === scale && c.strategy === strategy);
  const kw3 = at(3, "keyword");
  const kw100 = at(100, "keyword");
  const bm100 = at(100, "bm25");
  if (kw3 && kw100) {
    const drop = kw3.recallBase - kw100.recallBase;
    out.push(
      `- 关键词检索召回：N=3 ${(kw3.recallBase * 100).toFixed(0)}% → N=100 ${((kw100?.recallBase ?? 0) * 100).toFixed(0)}%（${drop > 0.05 ? `下降 ${(drop * 100).toFixed(0)} 个百分点` : "基本稳定"}）`,
    );
  }
  if (kw100 && bm100) {
    const diff = bm100.recallBase - kw100.recallBase;
    out.push(
      `- N=100 时 BM25 vs 关键词召回：${(bm100.recallBase * 100).toFixed(0)}% vs ${(kw100.recallBase * 100).toFixed(0)}%（${diff >= 0 ? `+${(diff * 100).toFixed(0)}` : (diff * 100).toFixed(0)} 百分点）`,
    );
  }
  const all10 = at(10, "all");
  const kw10 = at(10, "keyword");
  if (all10 && kw10) {
    out.push(
      `- all（不检索直喂全部）N=10：准确 ${(accuracy(all10) * 100).toFixed(0)}% vs keyword ${(accuracy(kw10) * 100).toFixed(0)}%，tokens ${all10.tokensMean} vs ${kw10.tokensMean}（候选膨胀直接推高成本）`,
    );
  }
  out.push("- 升级建议：见执行报告 RP-P3（IR-010 决策输入）");
  return out;
}

function accuracy(c: Cell): number {
  return (c.baseHit + c.needleHit + c.needleCorrectReject) / (c.baseTotal + c.needleTotal);
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
