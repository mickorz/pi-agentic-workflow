/**
 * pi-workflow route —— 共享路由 CLI（RP-P0 dry-run / RP-P2 --execute）
 *
 * 复用微信调度系统同一套 dispatch 层（PRD V2 §0：无第二套路由系统）：
 *   Registry（同注册表文件）+ IntentRouter（同提示词）+ Dispatcher（同两段式）
 *
 * 安全语义（§3.3）：
 *   - 默认 Dry-run：只调 plan()，零执行副作用（不产生 Run/TaskBinding/通知）
 *   - --execute 是启动请求而非危险权限：高风险（write/external-side-effect）
 *     一律 NOT_AUTHORIZED（执行前授权红线，CLI 不提供任何绕过手段）
 *
 * 用法：
 *   pi-workflow route --text "把 Hello world 翻译成中文" --registry dev-examples/wx-p1/registry.json
 *   pi-workflow route --text "..." --registry ... --scripts ... --execute
 *   选项：--json 机器可读输出；--model 覆盖默认模型；--channel cli|wechat（缺省 cli）
 */

import path from "node:path";
import { PiAgentAdapter } from "../../adapters/pi/pi-agent-adapter.js";
import type { RoutePlan } from "../../contracts/wx.js";
import { IntentRouter, type RoutingLLM } from "../../dispatch/intent-router.js";
import { WorkflowRegistry } from "../../dispatch/registry.js";

const MAX_TEXT = 2000; // 超长拒绝（防把上下文塞进路由提示词）

export interface RouteCliOptions {
  registryFile: string;
  scriptsRoot?: string;
  model?: string;
  channel?: "cli" | "wechat";
}

/** 构造与微信 start 同构的真实路由 LLM（tokens 经 onUsage 真实采集） */
export function buildRouteLlm(model?: string): RoutingLLM {
  const adapter = new PiAgentAdapter({ ...(model ? { defaultModel: model } : {}) });
  return {
    route: async (prompt) => {
      const started = Date.now();
      let tokens = 0;
      const out = await adapter.run(prompt, {
        label: "route-cli",
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

/** 路由计划（dry-run 核心，零副作用）：供 CLI 与评测器共用 */
export async function planRoute(text: string, options: RouteCliOptions): Promise<RoutePlan> {
  if (!text || !text.trim()) {
    throw Object.assign(new Error("空输入：--text 不能为空"), { code: "INVALID_INPUT" });
  }
  if (text.length > MAX_TEXT) {
    throw Object.assign(new Error(`超长拒绝：文本 ${text.length} 字符 > 上限 ${MAX_TEXT}`), { code: "INVALID_INPUT" });
  }
  const { registry, issues } = WorkflowRegistry.loadFromFile(options.registryFile);
  if (issues.length > 0) console.warn(`registry 问题条目：${issues.join("; ")}`);
  if (registry.all().length === 0) {
    throw Object.assign(new Error(`注册表为空：${options.registryFile}`), { code: "INVALID_INPUT" });
  }
  const router = new IntentRouter({ llm: buildRouteLlm(options.model), registry });
  return router.route(text);
}

export async function route(argv: string[]): Promise<number> {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const text = flag("--text");
  const json = argv.includes("--json");
  const registryFile = flag("--registry") ?? path.join(".pi-wechat", "workflows.json");

  try {
    const plan = await planRoute(text ?? "", {
      registryFile,
      ...(flag("--model") ? { model: flag("--model") } : {}),
      ...(flag("--scripts") ? { scriptsRoot: flag("--scripts") } : {}),
      ...(flag("--channel") === "wechat" ? { channel: "wechat" as const } : {}),
    });
    if (json) {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    } else {
      process.stdout.write(renderPlan(plan));
    }
    return 0;
  } catch (error) {
    const code = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      process.stdout.write(`${JSON.stringify({ error: { code: code ?? "ROUTE_FAILED", message } }, null, 2)}\n`);
    } else {
      process.stderr.write(`❌ ${code ? `[${code}] ` : ""}${message}\n`);
    }
    return code === "INVALID_INPUT" ? 2 : 1;
  }
}

function renderPlan(plan: RoutePlan): string {
  const lines = [
    `intent     : ${plan.intent}`,
    `action     : ${plan.action}`,
    `workflowId : ${plan.workflowId ?? "—"}`,
    `args       : ${plan.args ? JSON.stringify(plan.args) : "—"}`,
    `missing    : ${plan.missingFields?.length ? plan.missingFields.join(", ") : "—"}`,
    `reason     : ${plan.reason ?? "—"}`,
    `confidence : ${plan.confidence}`,
    `latencyMs  : ${plan.latencyMs ?? "—"}${plan.tokens ? `  tokens: ${plan.tokens}` : ""}`,
  ];
  return `${lines.join("\n")}\n`;
}
