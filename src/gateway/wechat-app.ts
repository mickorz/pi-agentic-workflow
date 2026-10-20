/**
 * WechatApp —— wechat-dispatch 长驻装配核心（WX-P2）
 *
 * 组合（P1 链路 + P2 可靠性）：
 *   BotAdapter → MessageInbox（持久化幂等）→ RateLimiter（频率）
 *   → Dispatcher（plan/execute + preStart 预算守卫）/ TaskController（查/取消/恢复/审批）
 *   → RunApplicationService（唯一启动入口）
 *   → Outbox（完成≠送达）→ BotAdapter.send
 *   RunMonitor（审批卡/终态通知入队）+ 审计全链路（AuditLog）
 *
 * WG-007：stop() 只停 Bot 与内部循环，绝不取消 Run。
 * CV-004：全部状态落 .pi-wechat/，重启后 new WechatApp(...) 即恢复。
 */

import path from "node:path";
import { AuditLog } from "../audit/audit-log.js";
import { type BotInboundMessage, DispatchError, type RoutePlan } from "../contracts/wx.js";
import { ConversationStore } from "../dispatch/conversation.js";
import { Dispatcher } from "../dispatch/dispatcher.js";
import type { ExecutionService } from "../dispatch/dispatcher.js";
import { IntentRouter, type RoutingLLM } from "../dispatch/intent-router.js";
import { BudgetTracker, RateLimiter } from "../dispatch/limits.js";
import type { WorkflowRegistry } from "../dispatch/registry.js";
import { RunMonitor } from "../dispatch/run-monitor.js";
import { type TaskControlService, TaskController } from "../dispatch/task-control.js";
import { TaskStore } from "../dispatch/task-store.js";
import { ModelRoutingLog } from "../model-routing/model-router.js";
import type { ModelRouter } from "../model-routing/model-router.js";
import { Outbox, type OutboxOptions } from "../notify/outbox.js";
import { MessageInbox } from "./message-inbox.js";
import type { BotAdapter } from "./wechat/bot-adapter.js";

export interface WechatAppLimits {
  rateWindowMs?: number;
  rateMax?: number;
  /** 每用户 Token 预算（0/缺省 = 不限） */
  maxTokensPerUser?: number;
}

export interface WechatAppDeps {
  bot: BotAdapter;
  registry: WorkflowRegistry;
  llm: RoutingLLM;
  /** 生产 = RunApplicationService（同时满足 ExecutionService 与 TaskControlService） */
  service: ExecutionService & TaskControlService;
  scriptsRoot: string;
  dataDir: string;
  defaultModel?: string;
  limits?: WechatAppLimits;
  /** 模型路由（决策经钩子进审计与路由日志） */
  modelRouter?: ModelRouter;
  outbox?: OutboxOptions;
  pollMs?: number;
  /** Outbox 投递间隔（缺省 5s） */
  flushMs?: number;
}

export class WechatApp {
  readonly inbox: MessageInbox;
  readonly conversation: ConversationStore;
  readonly tasks: TaskStore;
  readonly audit: AuditLog;
  readonly outbox: Outbox;
  readonly modelRoutes: ModelRoutingLog;
  readonly dispatcher: Dispatcher;
  readonly taskControl: TaskController;
  readonly monitor: RunMonitor;
  readonly rateLimiter: RateLimiter;
  readonly budget: BudgetTracker;
  private flushTimer?: NodeJS.Timeout;

  constructor(private readonly deps: WechatAppDeps) {
    const dataDir = path.resolve(deps.dataDir);
    this.inbox = new MessageInbox(dataDir);
    this.conversation = new ConversationStore(dataDir);
    this.tasks = new TaskStore(dataDir);
    this.audit = new AuditLog(dataDir);
    this.outbox = new Outbox(dataDir, { audit: this.audit, ...deps.outbox });
    this.modelRoutes = new ModelRoutingLog(dataDir);
    this.rateLimiter = new RateLimiter({
      windowMs: deps.limits?.rateWindowMs,
      max: deps.limits?.rateMax,
    });
    this.budget = new BudgetTracker({ maxTokensPerUser: deps.limits?.maxTokensPerUser, dataDir });
    this.taskControl = new TaskController({ tasks: this.tasks, service: deps.service, audit: this.audit });
    this.dispatcher = new Dispatcher({
      registry: deps.registry,
      router: new IntentRouter({ llm: deps.llm, registry: deps.registry }),
      tasks: this.tasks,
      service: deps.service,
      scriptsRoot: deps.scriptsRoot,
      ...(deps.defaultModel ? { defaultModel: deps.defaultModel } : {}),
      taskControl: this.taskControl,
      preStart: (plan, origin) => this.guardBudget(plan, origin.userId),
    });
    this.monitor = new RunMonitor({
      tasks: this.tasks,
      service: deps.service,
      outbox: this.outbox,
      audit: this.audit,
      ...(deps.pollMs ? { pollMs: deps.pollMs } : {}),
    });
  }

  /** 启动：Bot 接收 + 监控/投递循环 + 重启补扫（CV-004：待审批重通知、Outbox 补投） */
  async start(): Promise<void> {
    this.deps.bot.onMessage(async (message) => {
      await this.handleInbound(message);
    });
    await this.deps.bot.start();
    this.monitor.start();
    const flushMs = this.deps.flushMs ?? 5000;
    this.flushTimer = setInterval(() => {
      void this.outbox.flush((userId, text) => this.deps.bot.send(userId, text));
    }, flushMs);
    this.flushTimer.unref?.();
    // 重启补扫：先补投存量待发通知，再扫一轮待审批
    await this.outbox.flush((userId, text) => this.deps.bot.send(userId, text));
    await this.monitor.pollOnce();
  }

  /** WG-007：只停 Bot 与循环；运行中 Run 一律不动（可 CLI resume） */
  async stop(): Promise<void> {
    this.monitor.stop();
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = undefined;
    await this.deps.bot.stop();
  }

  /**
   * 入站消息全链路（幂等 → 限频 → 路由/执行/任务控制 → 审计 → Outbox 回复）。
   * duplicate → 不再处理；返回供测试断言。
   */
  async handleInbound(message: BotInboundMessage): Promise<{ duplicate: boolean; reply?: string; plan?: RoutePlan }> {
    const receipt = this.inbox.accept(message);
    if (receipt.status === "duplicate") return { duplicate: true };

    // SC-005/A18：消息频率
    const rate = this.rateLimiter.allow(message.userId);
    if (!rate.ok) {
      this.audit.record({
        actor: message.userId,
        action: "limit.reject",
        outcome: "rejected",
        detail: `频率超限，需等待 ${rate.retryAfterSec}s`,
      });
      return { duplicate: false, reply: `请求太频繁，请 ${rate.retryAfterSec} 秒后再试。` };
    }

    let plan: RoutePlan | undefined;
    try {
      const out = await this.dispatcher.handleMessage(message, this.conversation);
      plan = out.plan;
      this.audit.record({
        actor: message.userId,
        action: "intent.route",
        target: {
          ...(out.plan.workflowId ? { workflowId: out.plan.workflowId } : {}),
          ...(out.executeResult
            ? { runId: out.executeResult.runId, taskBindingId: out.executeResult.taskBindingId }
            : {}),
        },
        outcome: "ok",
        detail: `intent=${out.plan.intent} action=${out.plan.action} confidence=${out.plan.confidence.toFixed(2)}`,
      });
      if (out.executeResult) {
        this.audit.record({
          actor: message.userId,
          action: "run.start",
          target: {
            runId: out.executeResult.runId,
            taskBindingId: out.executeResult.taskBindingId,
            workflowId: out.plan.workflowId,
          },
          outcome: "ok",
        });
        this.conversation.setLastTask(message.userId, out.executeResult.taskBindingId);
        this.budget.record(message.userId, out.plan.tokens ?? 0);
      }
      this.enqueueReply(message.userId, out.reply, out.executeResult?.runId, out.executeResult?.taskBindingId);
      return { duplicate: false, reply: out.reply, plan: out.plan };
    } catch (error) {
      const isDispatch = error instanceof DispatchError;
      const text = isDispatch
        ? `⚠️ ${error.message}`
        : `❌ 处理失败：${error instanceof Error ? error.message : String(error)}`;
      if (isDispatch && error.code === "RUN_LIMIT") {
        this.audit.record({
          actor: message.userId,
          action: "limit.reject",
          outcome: "rejected",
          detail: error.message,
        });
      } else {
        this.audit.record({
          actor: message.userId,
          action: "intent.route",
          outcome: "rejected",
          detail: isDispatch ? `${error.code}: ${error.message}` : String(error),
        });
      }
      this.enqueueReply(message.userId, text);
      return { duplicate: false, reply: text };
    }
  }

  /** 手动触发投递（循环到无进展为止；测试/启动补投共用） */
  async flushOutbox(): Promise<{ sent: number; failed: number; deferred: number }> {
    const totals = { sent: 0, failed: 0, deferred: 0 };
    for (let round = 0; round < 10; round += 1) {
      const pass = await this.outbox.flush((userId, text) => this.deps.bot.send(userId, text));
      totals.sent += pass.sent;
      totals.failed += pass.failed;
      totals.deferred += pass.deferred;
      if (pass.sent === 0 && pass.failed === 0) break; // 收敛：无可再投递项
    }
    return totals;
  }

  /** 手动触发一轮监控扫描（测试/启动补扫共用） */
  async pollOnce(): Promise<void> {
    return this.monitor.pollOnce();
  }

  private guardBudget(plan: RoutePlan, userId: string): void {
    if (plan.intent !== "execute_workflow") return;
    const check = this.budget.check(userId);
    if (!check.ok) {
      throw new DispatchError(
        "RUN_LIMIT",
        `Token 预算已用尽（${check.used}/${check.limit}），新任务被拒绝。可发「任务列表」查看历史任务。`,
      );
    }
  }

  private enqueueReply(userId: string, reply: string, runId?: string, taskBindingId?: string): void {
    this.outbox.enqueue({
      userId,
      kind: "info",
      text: reply,
      ...(runId ? { runId } : {}),
      ...(taskBindingId ? { taskBindingId } : {}),
    });
    // 回复尽力即时投递（失败由 Outbox 循环重试）
    void this.outbox.flush((uid, text) => this.deps.bot.send(uid, text));
  }
}
