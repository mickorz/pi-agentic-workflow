/**
 * PiAgentAdapter —— AgentSessionRunner 的 Pi SDK 实现
 *
 * 职责：
 *  - 模型选择（ModelResolver：spec → Model；缺省用会话默认）
 *  - Session 隔离：每次 run() 创建独立 in-memory 会话（互不共享上下文），结束 dispose
 *  - 工具 profile：explore 只读白名单 / general 可写（执行层强制）
 *  - 取消：signal → session.abort()，等待 prompt 落定后统一清理
 *  - 用量统计：订阅 message_end（assistant）累加 usage，调 onUsage
 *  - 结构化输出：schema → prompt 追加 JSON 指令 + 本地解析（P1 完整校验）
 *
 * 错误契约：
 *  - 模型找不到 / SDK 创建失败 / prompt 抛错 → 原样抛出（runtime 层 wrapError 分类）
 *  - signal.aborted 后 prompt 落定 → 抛 "aborted"（被映射为 WORKFLOW_ABORTED）
 *  - 无论成功失败都 dispose
 */

import { randomUUID } from "node:crypto";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSessionRunner, AgentRunOptions, AgentExecutionResult } from "../../agent/session-runner.js";
import type { AgentUsage } from "../../runtime/types.js";
import { ModelResolver } from "./model-resolver.js";
import { resolveToolProfile } from "./tool-profiles.js";
import { validateJsonSchema } from "./schema-validator.js";

export interface PiAdapterOptions {
  /** 会话默认工作目录 */
  cwd?: string;
  /** 运行级默认模型 spec（"provider/modelId" 或裸 id；脚本级 model 优先） */
  defaultModel?: string;
}

export class PiAgentAdapter implements AgentSessionRunner {
  private readonly cwd: string;
  private readonly defaultModel?: string;
  private readonly resolver = new ModelResolver();

  constructor(options: PiAdapterOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.defaultModel = options.defaultModel;
  }

  async run(prompt: string, options: AgentRunOptions = {}): Promise<AgentExecutionResult> {
    const directory = options.directory ?? this.cwd;

    // 1) 工具 profile（结构性错误：unknown agentType 直接抛）
    const tools = resolveToolProfile(options.agentType);

    // 2) 模型解析（找不到模型 → 抛错 → fail-fast）
    const modelSpec = options.model ?? this.defaultModel;
    const model = modelSpec ? await this.resolver.resolve(modelSpec) : undefined;

    // 3) 独立 session（in-memory：不落会话文件，天然隔离）
    const sessionId = randomUUID();
    options.onSessionCreated?.(sessionId);

    const { session } = await createAgentSession({
      cwd: directory,
      ...(model ? { model } : {}),
      tools,
      sessionManager: SessionManager.inMemory(directory),
    });

    // 4) 用量统计：assistant message_end 累加
    let input = 0;
    let output = 0;
    let total = 0;
    let cost = 0;
    const unsubscribe = session.subscribe((event) => {
      const message = event.type === "message_end" ? event.message : undefined;
      if (message && message.role === "assistant" && message.usage) {
        const usage = message.usage;
        input += usage.input;
        output += usage.output;
        total += usage.totalTokens;
        cost += usage.cost?.total ?? 0;
      }
    });

    // 5) 取消接线：signal abort → session.abort()（等待 prompt 落定）
    const onAbort = () => {
      void session.abort();
    };
    options.signal?.addEventListener("abort", onAbort);

    try {
      const effectivePrompt = options.schema ? withSchemaInstruction(prompt, options.schema) : prompt;
      await session.prompt(effectivePrompt);

      if (options.signal?.aborted) {
        throw new Error(`agent "${options.label ?? prompt.slice(0, 24)}" aborted`);
      }

      if (total > 0) {
        const usage: AgentUsage = { input, output, total, ...(cost > 0 ? { cost } : {}) };
        options.onUsage?.(usage);
      }

      const text = session.getLastAssistantText() ?? "";

      if (options.schema) {
        const value = parseStructuredOutput(text, options.label);
        // 完整 JSON Schema 校验（P1-06）：失败抛错（可恢复，由 runtime 重试）；不假成功
        validateJsonSchema(value, options.schema);
        return { type: "structured", value, sessionId };
      }
      return { type: "text", value: text, sessionId };
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      unsubscribe();
      // 无论成功/失败/取消，都释放会话资源
      session.dispose();
    }
  }
}

/** schema 模式下的 prompt 增强：要求只输出符合 schema 的 JSON */
function withSchemaInstruction(prompt: string, schema: Record<string, unknown>): string {
  return [
    prompt,
    "",
    "请只输出一个符合以下 JSON Schema 的 JSON 对象（不要 markdown 代码块、不要解释文字）：",
    JSON.stringify(schema),
  ].join("\n");
}

/** 从模型回复中解析 JSON（容忍代码块包裹）；解析失败抛错（fail-fast，不返回假成功） */
function parseStructuredOutput(text: string, label: string | undefined): unknown {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];
  // 剥 ```json ... ``` 围栏
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence?.[1]) candidates.push(fence[1].trim());
  // 截取首个 { 到最后一个 }（模型多余解释的兜底）
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // 尝试下一个候选
    }
  }
  throw new Error(
    `agent "${label ?? "?"}" 结构化输出解析失败：模型回复不是合法 JSON（回复前 200 字符：${trimmed.slice(0, 200)}）`,
  );
}
