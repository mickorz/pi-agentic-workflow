/**
 * Intent Router（IR-001~007）：五类意图 + 候选匹配 + 结构化输出服务端强校验
 * LLM 可注入（NFR-002：单测不依赖真实 LLM）；提示词只含候选元数据不含源码（IR-002）。
 */

import { validateJsonSchema } from "../adapters/pi/schema-validator.js";
import type { RoutePlan, WorkflowRegistration, Action, Intent } from "../contracts/wx.js";

/** LLM 路由接口（Fake 可注入）；输出为原始 JSON 文本（服务端再校验） */
export interface RoutingLLM {
  route(prompt: string): Promise<{ text: string; latencyMs: number; tokens?: number }>;
}

export const CONFIDENCE_GATE = 0.75; // LK-05

export interface IntentRouterDeps {
  llm: RoutingLLM;
  registry: { search(text: string, limit?: number): WorkflowRegistration[]; get(id: string): WorkflowRegistration | undefined };
  /** confidence 门限（默认 0.75） */
  confidenceGate?: number;
}

export class IntentRouter {
  constructor(private readonly deps: IntentRouterDeps) {}

  /** 入口：文本 → RoutePlan（chat/unsupported/clarify/execute 分类 + 参数校验） */
  async route(text: string): Promise<RoutePlan> {
    if (!text || !text.trim()) {
      return plan("unsupported", "refuse", { reason: "空输入", confidence: 1 });
    }
    const candidates = this.deps.registry.search(text);
    const started = Date.now();
    let raw: { text: string; tokens?: number };
    try {
      const out = await this.deps.llm.route(this.buildPrompt(text, candidates));
      raw = { text: out.text, tokens: out.tokens };
    } catch (e) {
      // 模型调用失败 = 明确失败（不默选，IR-004 兜底仍要区分）
      return plan("unsupported", "refuse", { reason: `模型调用失败：${e instanceof Error ? e.message : String(e)}` , confidence: 0, latencyMs: Date.now() - started });
    }
    const gate = this.deps.confidenceGate ?? CONFIDENCE_GATE;

    // 服务端强校验（IR-003/007）：非法 JSON / 非白名单 workflowId / 低置信度 → unsupported
    let parsed: LlmRouteOutput;
    try {
      parsed = parseLlmJson(raw.text);
    } catch {
      return plan("unsupported", "refuse", { reason: "路由输出不是合法 JSON", confidence: 0, latencyMs: Date.now() - started, tokens: raw.tokens });
    }
    if (typeof parsed.confidence !== "number" || parsed.confidence < gate) {
      return plan("unsupported", "refuse", {
        reason: `置信度不足（${String(parsed.confidence)} < ${String(gate)}），请换种说法或指明工作流`,
        confidence: parsed.confidence ?? 0,
        latencyMs: Date.now() - started,
        tokens: raw.tokens,
      });
    }
    return this.classify(text, parsed, candidates, Date.now() - started, raw.tokens);
  }

  private async noop(): Promise<void> {}

  private buildPrompt(text: string, candidates: WorkflowRegistration[]): string {
    const meta = candidates.map((c) => ({
      workflowId: c.workflowId,
      name: c.name,
      description: c.description,
      keywords: c.keywords,
      requiredArgs: Object.keys((c.argsSchema as { required?: string[] }).required ?? []),
    }));
    return [
      `用户消息：${text}`,
      "",
      "候选工作流（仅元数据）：",
      JSON.stringify(meta, null, 2),
      "",
      "请只输出一个 JSON 对象：",
      '{"intent":"chat|execute_workflow|clarify|task_control|unsupported","workflowId":"候选内的 id 或 null","args":{...},"missingFields":["缺失必填字段"],"reason":"简短理由","confidence":0~1}',
      "规则：",
      "1. intent=execute_workflow 时 workflowId 必须来自候选；普通闲聊 intent=chat；查询/取消/列出任务用 intent=task_control；不明确该执行什么用 clarify 或 unsupported。",
      "2. 参数提取：若用户消息中已含必填参数的值（如 URL、要翻译/总结的文本、目标语言），必须提取填入 args 且 missingFields 为空数组；只有确实无法从消息推断时才把字段列入 missingFields。例如「分析 https://x」→ args.repoUrl=https://x。",
      "3. 同时提及多个候选时选最转指用户目标的那个（如「分析仓库并总结」目标是仓库分析）。",
      "4. 只输出 JSON，不要多余文字。",
      "示例：",
      "用户：分析 https://github.com/a/b → {\"intent\":\"execute_workflow\",\"workflowId\":\"github-review\",\"args\":{\"repoUrl\":\"https://github.com/a/b\"},\"missingFields\":[],\"confidence\":0.95}",
      "用户：把 Hello world 翻译成中文 → {\"intent\":\"execute_workflow\",\"workflowId\":\"translate\",\"args\":{\"text\":\"Hello world\",\"targetLang\":\"中文\"},\"missingFields\":[],\"confidence\":0.95}",
      "用户：帮我翻译 → {\"intent\":\"execute_workflow\",\"workflowId\":\"translate\",\"args\":{},\"missingFields\":[\"text\",\"targetLang\"],\"confidence\":0.85}",
      "用户：总结这篇 https://example.com/a 文章 → {\"intent\":\"execute_workflow\",\"workflowId\":\"summarize\",\"args\":{\"url\":\"https://example.com/a\"},\"missingFields\":[],\"confidence\":0.95}",
    ].join("\n");
  }

  private classify(
    text: string,
    parsed: LlmRouteOutput,
    candidates: WorkflowRegistration[],
    latencyMs: number,
    tokens?: number,
  ): RoutePlan {
    void text;
    void this.noop;
    const base = { confidence: parsed.confidence ?? 0, latencyMs, tokens };
    switch (parsed.intent as Intent) {
      case "chat":
        return plan("chat", "chat_reply", { reason: parsed.reason ?? "闲聊", ...base });
      case "task_control":
        return plan("task_control", "perform_task_control", { reason: parsed.reason ?? "", ...base });
      case "clarify":
        return plan("clarify", "ask_clarification", { reason: parsed.reason ?? "需要澄清", missingFields: parsed.missingFields ?? [], ...base });
      case "execute_workflow": {
        // IR-007：workflowId 必须命中白名单候选（防注入/篡改）
        const target = this.deps.registry.get(String(parsed.workflowId));
        if (!target || !candidates.some((c) => c.workflowId === target.workflowId)) {
          return plan("unsupported", "refuse", { reason: `未注册或不支持的流程：${String(parsed.workflowId)}`, ...base });
        }
        const args = (parsed.args ?? {}) as Record<string, unknown>;
        const required = ((target.argsSchema as { required?: string[] }).required ?? []);
        const missingFields = required.filter((k) => !(k in args) || args[k] === undefined || args[k] === "");
        if (missingFields.length > 0) {
          // IR-005：缺参 → clarify（不启动）
          return plan("execute_workflow", "ask_clarification", { workflowId: target.workflowId, args, missingFields, reason: `缺少参数：${missingFields.join(", ")}`, ...base });
        }
        try {
          validateJsonSchema(args, target.argsSchema);
        } catch (e) {
          return plan("execute_workflow", "ask_clarification", {
            workflowId: target.workflowId,
            missingFields: [],
            reason: `参数校验未通过：${e instanceof Error ? e.message : String(e)}`,
            ...base,
          });
        }
        return plan("execute_workflow", "start_execution", { workflowId: target.workflowId, args, ...base });
      }
      default:
        return plan("unsupported", "refuse", { reason: parsed.reason ?? "无法识别", ...base });
    }
  }
}

interface LlmRouteOutput {
  intent?: string;
  workflowId?: string | null;
  args?: Record<string, unknown>;
  missingFields?: string[];
  reason?: string;
  confidence?: number;
}

function plan(intent: Intent, action: Action, extra: Partial<RoutePlan> & { confidence: number }): RoutePlan {
  return { intent, action, ...extra };
}

function parseLlmJson(text: string): LlmRouteOutput {
  const trimmed = text.trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  const candidate = first >= 0 && last > first ? trimmed.slice(first, last + 1) : trimmed;
  return JSON.parse(candidate) as LlmRouteOutput;
}
