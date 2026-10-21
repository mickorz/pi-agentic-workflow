/**
 * PiSessionOpener（AM-P0 T2）：HostedAgentSession 的 Pi SDK 默认实现
 *
 * per-user 持久会话：
 *  - 会话文件确定性命名 <sessionDir>/am-<safe(userId)>-<hash8>.jsonl（路径注入安全）
 *  - SessionManager.open（文件不存在=空会话，首条消息落盘该文件）→ 重启后同文件
 *    重开：sessionId 稳定、历史上下文回放（已用真实 SDK 验证）
 *  - createAgentSession：tools 白名单=customTools 名单（只启用五工具，内置
 *    read/bash/edit/write 与 MCP 默认不激活；noTools:"all" 会连 customTools
 *    一起禁掉，不可用），customTools 经 SDK 注册
 *  - 用量：订阅 message_end（assistant）累加 usage，每轮 prompt 前清零（per-turn）
 *  - 回复：getLastAssistantText（与 PiAgentAdapter 同源约定）
 *
 * 与 PiAgentAdapter（V1 一次性 in-memory 会话）的区别：本会话跨 Turn 复用且落盘，
 * 不在每轮 dispose；进程退出由 AgentHost.dispose 统一释放。
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ModelResolver } from "../adapters/pi/model-resolver.js";
import type { HostedAgentSession, TurnContextRef, TurnEvent } from "./types.js";

export interface PiSessionOpenerOptions {
  /** 会话工作目录 */
  cwd: string;
  /** per-user 会话文件目录（.pi-agent-host/sessions） */
  sessionDir: string;
  /** 模型 spec（provider/modelId 或裸 id；缺省用 settings 默认模型） */
  model?: string;
  /** 五工具（T3 提供；P0 会话只启用这些工具） */
  customTools?: ToolDefinition[];
  /** 工具工厂（T3）：每会话独立 ctxRef，工具闭包读当前 Turn 上下文（优先于 customTools） */
  toolsFactory?: (ctxRef: TurnContextRef) => ToolDefinition[];
}

/** userId → 安全文件名（防路径注入；截断 + 哈希后缀防碰撞） */
export function sessionFileName(userId: string): string {
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
  const hash = createHash("sha256").update(userId).digest("hex").slice(0, 8);
  return `am-${safe}-${hash}`;
}

export class PiSessionOpener {
  private readonly resolver = new ModelResolver();

  constructor(private readonly opts: PiSessionOpenerOptions) {}

  sessionFile(userId: string): string {
    return path.join(this.opts.sessionDir, `${sessionFileName(userId)}.jsonl`);
  }

  async open(userId: string): Promise<HostedAgentSession> {
    fs.mkdirSync(this.opts.sessionDir, { recursive: true });
    const manager = SessionManager.open(this.sessionFile(userId), this.opts.sessionDir, this.opts.cwd);
    const model = this.opts.model ? await this.resolver.resolve(this.opts.model) : undefined;
    // 每会话独立 Turn 上下文槽：AgentHost 每 Turn 写入，五工具闭包读取（T3）
    const ctxRef: TurnContextRef = { current: undefined };
    const tools = this.opts.toolsFactory ? this.opts.toolsFactory(ctxRef) : (this.opts.customTools ?? []);
    const { session } = await createAgentSession({
      cwd: this.opts.cwd,
      ...(model ? { model } : {}),
      tools: tools.map((t) => t.name),
      customTools: tools,
      sessionManager: manager,
    });

    let inputTokens = 0;
    let outputTokens = 0;
    let observer: ((e: TurnEvent) => void) | undefined;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        if (event.message.usage) {
          inputTokens += event.message.usage.input;
          outputTokens += event.message.usage.output;
        }
        observer?.({ type: "llm_request" });
      } else if (event.type === "tool_execution_start") {
        observer?.({ type: "tool_call" });
      }
    });

    return {
      conversationId: manager.getSessionId(),
      setTurnContext: (ctx) => {
        ctxRef.current = ctx;
      },
      observe: (onEvent) => {
        observer = onEvent;
      },
      currentUsage: () => ({ inputTokens, outputTokens }),
      abort: () => session.abort(),
      prompt: async (text: string) => {
        inputTokens = 0;
        outputTokens = 0;
        await session.prompt(text);
        return {
          replyText: session.getLastAssistantText() ?? "",
          usage: { inputTokens, outputTokens },
        };
      },
      dispose: () => {
        unsubscribe();
        session.dispose();
      },
    };
  }
}
