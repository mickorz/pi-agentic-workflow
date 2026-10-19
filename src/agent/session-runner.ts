/**
 * AgentSessionRunner —— Runtime 与 Pi SDK 之间的最小注入缝
 *
 * 依赖方向：
 *  src/runtime/（禁止 import Pi SDK / CLI）
 *   -> AgentSessionRunner 接口（本文件，无任何 Pi 依赖）
 *        -> PiAgentAdapter 实现（src/adapters/pi/）
 *             -> @earendil-works/pi-coding-agent 的 createAgentSession
 *
 *  测试在接口处注入 fake runner（countingAgent / deferredAgent 模式）。
 */

import type { AgentUsage } from "../runtime/types.js";

/** 传给 Adapter 的单次 agent 调用选项（runtime 组装，脚本不直接可见） */
export interface AgentRunOptions {
  label?: string;
  phase?: string;
  /** agent 类型（explore=只读分析 / general=可写；缺省 explore） */
  agentType?: "explore" | "general" | string;
  /** "provider/modelId" 或裸 "modelId"；缺省用运行级默认模型 */
  model?: string;
  /** JSON Schema 对象；存在时要求结构化输出（本地解析+校验，P1 完整化） */
  schema?: Record<string, unknown>;
  /** 本 attempt 的取消信号（run 级 abort 或本 agent 超时触发） */
  signal?: AbortSignal;
  /** 会话工作目录（缺省 adapter 的 cwd） */
  directory?: string;
  /** Adapter 从 SDK 事件提取用量后回调 */
  onUsage?: (usage: AgentUsage) => void;
  /** Adapter 建完子会话后立即回调（running 态就能拿到 sessionId） */
  onSessionCreated?: (sessionId: string) => void;
}

/**
 * Adapter 统一执行结果：text / structured 两分支 + 子会话 ID。
 * 仅在 runtime 内部流转；对 workflow 脚本的 agent() 直接返回 value。
 */
export type AgentExecutionResult =
  | { type: "text"; value: string; sessionId: string }
  | { type: "structured"; value: unknown; sessionId: string };

/** 最小 runner 接口：Runtime 只认这个形状 */
export interface AgentSessionRunner {
  run(prompt: string, options?: AgentRunOptions): Promise<AgentExecutionResult>;
}
