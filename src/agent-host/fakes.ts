/**
 * AM-P0 测试替身（T1）：FakeAgentSession / FakeAgentToolFacade
 * 供 T2~T8 模块单测与 WechatApp agent 分支测试注入（不依赖真实 LLM/Pi SDK 会话）。
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AgentToolFacade,
  HostedAgentSession,
  TurnContext,
  WorkflowExecuteResult,
  WorkflowSearchItem,
} from "./types.js";

/** 脚本化会话：按预设脚本依次"决策"（调用工具或给出最终回复），记录全部调用 */
export interface FakeTurnScript {
  /** 每步：null = 给出最终回复结束 Turn；否则调用该工具 */
  steps: Array<{ tool: string; args: Record<string, unknown> } | null>;
  finalReply: string;
}

export class FakeAgentSession {
  readonly prompts: string[] = [];
  readonly toolCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  readonly replies: string[] = [];
  private scriptQueue: FakeTurnScript[] = [];

  queueScript(script: FakeTurnScript): void {
    this.scriptQueue.push(script);
  }

  /** 模拟 session.prompt()：执行当前脚本（工具调用经 facade），返回最终回复文本 */
  async prompt(_text: string, facade: AgentToolFacade): Promise<string> {
    this.prompts.push(_text);
    const script = this.scriptQueue.shift();
    if (!script) return this.replies.at(-1) ?? "";
    let reply = script.finalReply;
    for (const step of script.steps) {
      if (step === null) break;
      this.toolCalls.push(step);
      await this.callTool(step.tool, step.args, facade); // 工具结果仅作为会话上下文，不覆盖最终回复
    }
    this.replies.push(reply);
    return reply;
  }

  private async callTool(
    tool: string,
    args: Record<string, unknown>,
    facade: AgentToolFacade,
  ): Promise<string | null> {
    switch (tool) {
      case "workflow_search": {
        const items = await facade.searchWorkflows(args.query as string | undefined);
        return JSON.stringify(items);
      }
      case "workflow_execute": {
        const r: WorkflowExecuteResult = await facade.executeWorkflow({
          userId: args.userId as string,
          workflowId: args.workflowId as string,
          args: args.args,
          agentTurnId: args.agentTurnId as string,
          originMessageId: args.originMessageId as string,
        });
        return JSON.stringify(r);
      }
      case "task_status": {
        const r = await facade.taskStatus(args.userId as string, {
          runId: args.runId as string | undefined,
          taskBindingId: args.taskBindingId as string | undefined,
        });
        return JSON.stringify(r);
      }
      default:
        return null;
    }
  }
}

/** Fake Facade：记录调用 + 可配置返回 */
export class FakeAgentToolFacade implements AgentToolFacade {
  readonly searchCalls: Array<string | undefined> = [];
  readonly executeCalls: Array<{ userId: string; workflowId: string; args: unknown }> = [];
  readonly statusCalls: Array<{ userId: string; runId?: string }> = [];

  searchResult: WorkflowSearchItem[] = [
    { id: "github-review", name: "GitHub 审查", description: "分析仓库", requiredArgs: ["repoUrl"], riskLevel: "read-only" },
    { id: "deploy-service", name: "部署", description: "部署服务", requiredArgs: [], riskLevel: "write" },
  ];
  executeResult: WorkflowExecuteResult = { accepted: true, runId: "run-fake-1", taskBindingId: "tb-fake-1", status: "running" };
  statusResult = { runId: "run-fake-1", status: "completed", resultSummary: "ok", resultRef: "out/a.md" };

  async searchWorkflows(query?: string): Promise<WorkflowSearchItem[]> {
    this.searchCalls.push(query);
    return this.searchResult;
  }
  async executeWorkflow(input: { userId: string; workflowId: string; args: unknown }): Promise<WorkflowExecuteResult> {
    this.executeCalls.push({ userId: input.userId, workflowId: input.workflowId, args: input.args });
    return this.executeResult;
  }
  async taskStatus(userId: string, ref: { runId?: string }): Promise<{ runId: string; status: string; resultSummary?: string; resultRef?: string }> {
    this.statusCalls.push({ userId, runId: ref.runId });
    return this.statusResult;
  }
  async taskCancel(): Promise<{ ok: boolean; message: string }> {
    return { ok: true, message: "已取消" };
  }
  async taskResume(
    _userId?: string,
    _runId?: string,
    _options?: { confirmSideEffects?: boolean },
  ): Promise<{ ok: boolean; message: string }> {
    return { ok: true, message: "已恢复" };
  }
}

// ── T2：HostedAgentSession 测试替身 ──

/** 自动回复会话：prompt 立即返回预设回复；可选按轮次抛错（测试失败路径）；记录 Turn 上下文写入 */
export class ScriptedHostedSession implements HostedAgentSession {
  readonly prompts: string[] = [];
  readonly turnContexts: TurnContext[] = [];
  constructor(
    readonly conversationId: string,
    private readonly replies: string[] = ["好的"],
    private readonly errors: Array<Error | undefined> = [],
  ) {}
  setTurnContext(ctx: TurnContext): void {
    this.turnContexts.push(ctx);
  }
  async prompt(text: string): Promise<{ replyText: string; usage: { inputTokens: number; outputTokens: number } }> {
    this.prompts.push(text);
    const err = this.errors[this.prompts.length - 1];
    if (err) throw err;
    return {
      replyText: this.replies[this.prompts.length - 1] ?? this.replies[this.replies.length - 1] ?? "",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }
}

/** 门控会话：prompt 阻塞直到手动 release()（时序测试：排队/并行/恢复窗口）；记录 Turn 上下文写入 */
export class GatedHostedSession implements HostedAgentSession {
  readonly prompts: string[] = [];
  readonly turnContexts: TurnContext[] = [];
  private gates: Array<() => void> = [];
  constructor(
    readonly conversationId: string,
    private readonly replies: string[] = ["ok"],
    private readonly errors: Array<Error | undefined> = [],
  ) {}
  setTurnContext(ctx: TurnContext): void {
    this.turnContexts.push(ctx);
  }
  /** 放行最早一个被阻塞的 prompt */
  release(): void {
    this.gates.shift()?.();
  }
  async prompt(text: string): Promise<{ replyText: string; usage: { inputTokens: number; outputTokens: number } }> {
    this.prompts.push(text);
    await new Promise<void>((resolve) => this.gates.push(resolve));
    const err = this.errors[this.prompts.length - 1];
    if (err) throw err;
    return {
      replyText: this.replies[this.prompts.length - 1] ?? "ok",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }
}

/** 文件持久会话注册表：conversationId 落盘、同 userId 复用同实例；reset() 模拟进程重启（丢内存会话对象、会话文件保留，新实例重开同文件） */
export class FileBackedSessionRegistry {
  readonly sessions = new Map<string, HostedAgentSession>();
  openCalls: string[] = [];
  constructor(
    private readonly sessionDir: string,
    private readonly make: (conversationId: string) => HostedAgentSession = (id) => new ScriptedHostedSession(id),
  ) {}
  /** 模拟进程重启：内存会话对象丢弃，conversationId 文件保留（新会话同文件重开） */
  reset(): void {
    this.sessions.clear();
  }
  readonly opener = async (userId: string): Promise<HostedAgentSession> => {
    this.openCalls.push(userId);
    const existing = this.sessions.get(userId);
    if (existing) return existing;
    fs.mkdirSync(this.sessionDir, { recursive: true });
    const file = path.join(this.sessionDir, `conv-${userId}.json`);
    let conversationId: string;
    if (fs.existsSync(file)) {
      conversationId = fs.readFileSync(file, "utf8");
    } else {
      conversationId = `conv-${randomUUID()}`;
      fs.writeFileSync(file, conversationId, "utf8");
    }
    const session = this.make(conversationId);
    this.sessions.set(userId, session);
    return session;
  };
}
