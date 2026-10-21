/**
 * AgentHost（AM-P0 T2；V2.1 §2.1）
 *
 * 职责：
 *  - per-user 持久会话：惰性创建/复用（openSession 注入缝；缺省 PiSessionOpener）
 *  - 同用户消息排队（P0 锁定语义）：每用户单活动 Turn；新消息持久化排队（InboxJournal
 *    state=received），前一 Turn 完成后依次 session.prompt()；**不使用 followUp()**；
 *    不同用户可并行
 *  - 回执语义：首条消息 handleMessage 等待本轮完成返回 TurnResult（processed）；
 *    排队消息完成后经 onTurnCompleted 回调（gateway 接 Outbox 异步推送）
 *  - 重启恢复（§4）：recover() 从 InboxJournal 取未完成消息——received（Agent 从未见过）
 *    重新入队处理；processing（中断时副作用不确定）禁止重调 Agent，仅告警回调，
 *    T4/T5 接入 PendingAction/RunLaunchAttempt 关联核查后细化
 *
 * 不做：预算（T6 接 TurnBudget）、五工具（T3 经 customTools 注入 createAgentSession）。
 */

import { randomUUID } from "node:crypto";
import { InboxJournal } from "./inbox-journal.js";
import { TurnBudget, UnlimitedCumulativeBudget, overCumulativeTolerance } from "./agent-budget.js";
import type { CumulativeBudget } from "./agent-budget.js";
import type { HostedAgentSession, InboxJournalEntry, TurnEvent } from "./types.js";
import type { AgentMessageInput, AgentHostDeps, HandleOutcome, SessionOpener, TurnResult } from "./types.js";
import { PiSessionOpener } from "./pi-session.js";

export interface RecoveryReport {
  /** received 消息数（已重新入队处理） */
  requeued: number;
  /** processing 中断消息（不确定副作用；未重调 Agent，待人工/后续核查） */
  uncertain: InboxJournalEntry[];
}

export class AgentHost {
  private readonly journal: InboxJournal;
  private readonly opener: SessionOpener;
  private readonly sessions = new Map<string, HostedAgentSession>();
  /** 有 drain 在跑的用户（单活动 Turn 的串行锁） */
  private readonly runningUsers = new Set<string>();
  private readonly cumulative: CumulativeBudget;
  private readonly budgetPollMs: number;

  constructor(private readonly deps: AgentHostDeps) {
    this.journal = new InboxJournal(deps.dataDir);
    this.cumulative = deps.cumulative ?? new UnlimitedCumulativeBudget();
    this.budgetPollMs = deps.budgetPollMs ?? 500;
    const fallback = new PiSessionOpener({
      cwd: deps.cwd,
      sessionDir: deps.sessionDir,
      ...(deps.model ? { model: deps.model } : {}),
      ...(deps.toolsFactory ? { toolsFactory: deps.toolsFactory } : {}),
      customTools: deps.customTools,
    });
    this.opener = deps.openSession ?? ((userId: string) => fallback.open(userId));
  }

  /** gateway 只读访问（T7 接线状态查询） */
  get inbox(): InboxJournal {
    return this.journal;
  }

  /**
   * 处理一条入站消息：journal 快照去重 → 空闲则本轮同步执行（返回回执），
   * 忙则持久化排队（返回 queued，完成后走 onTurnCompleted）。
   * 本轮 prompt 失败：journal 标记 failed 并向调用方抛错（排队消息继续 drain，不断队列）。
   */
  async handleMessage(msg: AgentMessageInput): Promise<HandleOutcome> {
    const { entry, duplicate } = this.journal.record({
      channel: msg.channel,
      messageId: msg.messageId,
      userId: msg.userId,
      text: msg.text,
      receivedAt: msg.receivedAt ?? new Date().toISOString(),
    });
    if (duplicate) return { status: "duplicate", state: entry.state };
    if (this.runningUsers.has(msg.userId)) return { status: "queued" };

    this.runningUsers.add(msg.userId);
    try {
      const result = await this.runTurn(msg.userId, entry);
      return { status: "processed", result };
    } finally {
      // 首轮回执返回后，后台清空该用户排队消息（drain 自释放 runningUsers）
      void this.drain(msg.userId);
    }
  }

  /**
   * 启动恢复（§4）：不等消息重新通过旧 Inbox 去重，直接从 Journal 取未完成消息。
   * received → 重新入队处理（按用户并行 drain）；processing → 不确定副作用禁止重调
   * Agent，逐条告警回调，保持 processing 态待人工核对（T4/T5 接入关联核查）。
   */
  async recover(): Promise<RecoveryReport> {
    const unfinished = this.journal.unfinished();
    const uncertain = unfinished.filter((e) => e.state === "processing");
    for (const e of uncertain) this.deps.onUncertainRecovery?.(e);

    const received = unfinished.filter((e) => e.state === "received");
    const users = [...new Set(received.map((e) => e.userId))];
    for (const userId of users) {
      if (this.runningUsers.has(userId)) continue; // 已在跑：drain 循环会自然捞起
      this.runningUsers.add(userId);
      void this.drain(userId);
    }
    return { requeued: received.length, uncertain };
  }

  /** 释放全部底层会话（进程退出时调用） */
  dispose(): void {
    for (const s of this.sessions.values()) s.dispose?.();
    this.sessions.clear();
  }

  /** 依次处理该用户 journal 中 received 态消息，直到清空；单条失败标记 failed 继续 */
  private async drain(userId: string): Promise<void> {
    try {
      for (;;) {
        const next = this.journal
          .unfinished()
          .find((e) => e.state === "received" && e.userId === userId);
        if (!next) break;
        try {
          await this.runTurn(userId, next);
        } catch {
          // runTurn 已 markFailed；排队消息逐条独立，失败不断队列
        }
      }
    } finally {
      this.runningUsers.delete(userId);
    }
  }

  private async runTurn(userId: string, entry: InboxJournalEntry): Promise<TurnResult> {
    const agentTurnId = randomUUID();
    // 双层预算（§6）：累计预算开始前检查（不足不开会话）；单 Turn 硬限执行中实时中止
    const budget = new TurnBudget(this.cumulative, this.deps.limits);
    if (!budget.begin(userId).ok) {
      this.journal.markProcessing(entry.channel, entry.messageId, agentTurnId);
      this.journal.markFailed(entry.channel, entry.messageId);
      throw new Error("累计 Token 预算已用尽，本轮不执行（已启动任务不受影响）");
    }
    this.journal.markProcessing(entry.channel, entry.messageId, agentTurnId);
    const session = await this.openSession(userId);
    session.setTurnContext?.({ userId, agentTurnId, originMessageId: entry.messageId });

    budget.activate();
    let limitHit: string | null = null;
    const tripLimit = (why: string) => {
      if (limitHit) return;
      limitHit = why;
      // 安全停止：仅中止 Agent Loop；已启动 Workflow（工具内 Run）不受影响
      void Promise.resolve(session.abort?.()).catch(() => undefined);
    };
    session.observe?.((e: TurnEvent) => {
      if (e.type === "llm_request") budget.onLlmRequest();
      else budget.onToolCall();
      const usage = session.currentUsage?.();
      if (
        usage &&
        overCumulativeTolerance(this.cumulative, userId, usage.inputTokens + usage.outputTokens)
      ) {
        tripLimit("cumulative");
        return;
      }
      const why = budget.exceeded();
      if (why) tripLimit(why);
    });
    const timer = setInterval(() => {
      const why = budget.exceeded();
      if (why) tripLimit(why);
    }, this.budgetPollMs);
    timer.unref?.(); // 被弃置的 Turn（如测试门控永不放行）不阻止进程退出

    try {
      const outcome = await session.prompt(entry.text);
      budget.settle(userId, outcome.usage);
      this.journal.markCompleted(entry.channel, entry.messageId);
      const replyText = limitHit
        ? `⚠️ 已达单轮预算上限（${limitHit}），已安全停止；已启动的任务不受影响，可稍后查询任务状态继续跟进。\n${outcome.replyText}`
        : outcome.replyText;
      const result: TurnResult = {
        userId,
        conversationId: session.conversationId,
        agentTurnId,
        replyText,
        usage: outcome.usage,
      };
      this.deps.onTurnCompleted?.(result);
      return result;
    } catch (err) {
      // 失败也入账（已读实时用量则按实际，否则零）
      const partial = session.currentUsage?.();
      budget.settle(userId, partial ?? { inputTokens: 0, outputTokens: 0 });
      this.journal.markFailed(entry.channel, entry.messageId);
      throw err;
    } finally {
      clearInterval(timer);
    }
  }

  private async openSession(userId: string): Promise<HostedAgentSession> {
    const cached = this.sessions.get(userId);
    if (cached) return cached;
    const session = await this.opener(userId);
    this.sessions.set(userId, session);
    return session;
  }
}
