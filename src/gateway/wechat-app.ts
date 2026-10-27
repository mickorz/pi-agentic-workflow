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
import { randomUUID } from "node:crypto";
import { AuditLog } from "../audit/audit-log.js";
import { type BotInboundMessage, DispatchError, type RoutePlan } from "../contracts/wx.js";
import { ConversationStore } from "../dispatch/conversation.js";
import { Dispatcher } from "../dispatch/dispatcher.js";
import type { ExecutionService } from "../dispatch/dispatcher.js";
import { IntentRouter, type RoutingLLM } from "../dispatch/intent-router.js";
import { routeByUrlDirect } from "../dispatch/url-router.js";
import { WORKFLOW_CATALOG_RE, renderWorkflowCatalog } from "./catalog.js";
import { BudgetTracker, RateLimiter } from "../dispatch/limits.js";
import type { WorkflowRegistry } from "../dispatch/registry.js";
import { RunMonitor } from "../dispatch/run-monitor.js";
import { type TaskControlService, TaskController, parseVerb } from "../dispatch/task-control.js";
import { TaskStore } from "../dispatch/task-store.js";
import { ModelRoutingLog } from "../model-routing/model-router.js";
import type { ModelRouter } from "../model-routing/model-router.js";
import { Outbox, type OutboxOptions } from "../notify/outbox.js";
import { MessageInbox } from "./message-inbox.js";
import type { BotAdapter } from "./wechat/bot-adapter.js";
import { AgentHost } from "../agent-host/agent-host.js";
import type { RoutingMode, SessionOpener } from "../agent-host/types.js";
import { TaskControlFacade } from "../agent-host/task-control-facade.js";
import { PendingActionService, renderPendingActionApproval } from "../agent-host/pending-flow.js";
import { LaunchCoordinator } from "../agent-host/launch-flow.js";
import { PendingActionStore } from "../agent-host/pending-action.js";
import { RunLaunchStore, RunLinkStore } from "../agent-host/run-launch.js";
import { createAgentTools } from "../agent-host/agent-tools.js";
import type { CumulativeBudget } from "../agent-host/agent-budget.js";

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
  /** 运营统计（F8 status 增强：最近收发/累计 token；缺省不采集） */
  stats?: {
    recordInbound(): void;
    recordOutbound(): void;
    recordTurn(tokens: number): void;
    flushSync(): void;
  };
  outbox?: OutboxOptions;
  pollMs?: number;
  /** Outbox 投递间隔（缺省 5s） */
  flushMs?: number;
  /** AM-P0（§2.4 Feature Flag）：legacy = 旧 IntentRouter 链路（零改动，缺省）；agent = Conversational Agent */
  routingMode?: RoutingMode;
  /** agent 模式：Agent 会话开启器注入缝（缺省 PiSessionOpener 真实 SDK 会话） */
  agentOpenSession?: SessionOpener;
  /** agent 模式：会话目录（缺省 dataDir 同级 .pi-agent-host/sessions） */
  agentSessionDir?: string;
  /** agent 模型 spec（缺省用 defaultModel；再缺省用 settings 默认模型） */
  agentModel?: string;
  /** agent 单 Turn 硬限（缺省 DEFAULT_TURN_LIMITS） */
  agentLimits?: import("../agent-host/types.js").TurnLimits;
  /** 自动批准白名单（--auto-approve）：命中的高风险流程跳过审批直接执行（预检照常；缺省空） */
  autoApprove?: readonly string[];
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
  /** agent 模式装配（legacy 模式均为 undefined） */
  readonly agentHost?: AgentHost;
  readonly launcher?: LaunchCoordinator;
  readonly pendingFlow?: PendingActionService;
  readonly pendingStore?: PendingActionStore;
  readonly runLinks?: RunLinkStore;
  readonly agentFacade?: TaskControlFacade;
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

    // ── AM-P0 agent 分支装配（§2.4：进入 agent 分支负责到底；legacy 零改动） ──
    let monitorRunLinks: RunLinkStore | undefined;
    if (deps.routingMode === "agent") {
      const runLinks = new RunLinkStore(dataDir);
      const launcher = new LaunchCoordinator({
        attempts: new RunLaunchStore(dataDir),
        runLinks,
        dispatcher: this.dispatcher,
        tasks: this.tasks,
        onUnknown: (a) => {
          this.audit.record({
            actor: a.userId,
            action: "am.launch.unknown",
            outcome: "rejected",
            target: { attemptId: a.attemptId, workflowId: a.workflowId },
            detail: "启动结果不确定（方案 B）：禁自动重试，待人工比对 .pi-workflows/runs/",
          });
        },
      });
      const pendingStore = new PendingActionStore(dataDir);
      const pendingFlow = new PendingActionService({
        pending: pendingStore,
        registry: deps.registry,
        launcher,
        onUncertain: (a) => {
          this.audit.record({
            actor: a.userId,
            action: "am.pending.uncertain",
            outcome: "rejected",
            target: { actionId: a.actionId, workflowId: a.workflowId },
            detail: "确认后中断（executing 悬置）：待人工核对，禁自动重试",
          });
        },
      });
      const facade = new TaskControlFacade({
        registry: deps.registry,
        launcher,
        tasks: this.tasks,
        service: deps.service,
        pending: pendingStore,
        runLinks,
        ...(deps.autoApprove ? { autoApprove: deps.autoApprove } : {}),
        // VR #12：审批卡由服务端确定性生成（三要素），创建即推送，不依赖 Agent 自行描述
        onPendingCreated: (a) => {
          this.enqueueReply(a.userId, renderPendingActionApproval(a));
        },
      });
      const modelSpec = deps.agentModel ?? deps.defaultModel;
      const cumulative: CumulativeBudget = {
        remaining: (userId) => {
          const max = deps.limits?.maxTokensPerUser ?? 0;
          if (max <= 0) return Infinity;
          return max - this.budget.used(userId);
        },
        settle: (userId, total) => this.budget.record(userId, total),
      };
      const agentHost = new AgentHost({
        cwd: process.cwd(),
        sessionDir: deps.agentSessionDir ?? path.resolve(dataDir, "..", ".pi-agent-host", "sessions"),
        dataDir,
        ...(modelSpec ? { model: modelSpec } : {}),
        customTools: [],
        facade,
        ...(deps.agentLimits ? { limits: deps.agentLimits } : {}),
        ...(deps.agentOpenSession ? { openSession: deps.agentOpenSession } : {}),
        toolsFactory: (ctxRef) => createAgentTools({ facade, ctxRef }),
        cumulative,
        onTurnCompleted: (r) => {
          // 所有 Turn（含排队 drain）统一出口：入账 + 审计 + 回执。
          // 注意：回执仅在此处入队一次——processed 分支不得重复 enqueueReply（曾致真机双发）
          this.budget.record(r.userId, r.usage.inputTokens + r.usage.outputTokens);
          this.deps.stats?.recordTurn(r.usage.inputTokens + r.usage.outputTokens); // F8 累计 token
          this.audit.record({
            actor: r.userId,
            action: "am.turn.completed",
            target: { agentTurnId: r.agentTurnId, conversationId: r.conversationId },
            outcome: "ok",
            detail: `reply=${r.replyText.slice(0, 60)} tokens=${r.usage.inputTokens + r.usage.outputTokens}`,
          });
          this.enqueueReply(r.userId, r.replyText);
        },
        onUncertainRecovery: (e) => {
          this.audit.record({
            actor: e.userId,
            action: "am.recovery.uncertain",
            outcome: "rejected",
            target: { messageId: e.messageId },
            detail: `消息处理中断（不确定副作用）：${e.text.slice(0, 80)}`, // 快照已落盘，禁止重调 Agent
          });
          this.enqueueReply(
            e.userId,
            "⚠️ 你此前的一条消息在处理中中断（可能已有部分操作执行）。为避免重复执行已转入人工核对，请勿重复发起。",
          );
        },
      });
      this.runLinks = runLinks;
      this.launcher = launcher;
      this.pendingStore = pendingStore;
      this.pendingFlow = pendingFlow;
      this.agentFacade = facade;
      this.agentHost = agentHost;
      monitorRunLinks = runLinks;
    }

    this.monitor = new RunMonitor({
      tasks: this.tasks,
      service: deps.service,
      outbox: this.outbox,
      audit: this.audit,
      ...(monitorRunLinks ? { runLinks: monitorRunLinks } : {}),
      ...(deps.pollMs ? { pollMs: deps.pollMs } : {}),
    });
  }

  /** 启动：Bot 接收 + 监控/投递循环 + 重启补扫（CV-004：待审批重通知、Outbox 补投） */
  async start(): Promise<void> {
    this.deps.bot.onMessage(async (message) => {
      this.deps.stats?.recordInbound();
      await this.handleInbound(message);
    });
    await this.deps.bot.start();
    this.monitor.start();
    const flushMs = this.deps.flushMs ?? 5000;
    const sendAndRecord = async (userId: string, text: string): Promise<void> => {
      await this.deps.bot.send(userId, text);
      this.deps.stats?.recordOutbound(); // 发送成功才计（完成≠送达原则的反面：送达才计）
    };
    this.flushTimer = setInterval(() => {
      void this.outbox.flush(sendAndRecord);
    }, flushMs);
    this.flushTimer.unref?.();
    // 重启补扫：先补投存量待发通知，再扫一轮待审批
    await this.outbox.flush(sendAndRecord);
    await this.monitor.pollOnce();
    // agent 模式恢复（§4/§3.3/§2.3）：journal 未完成 → attempts 补链/unknown → 悬置授权告警
    if (this.agentHost) {
      const rec = await this.agentHost.recover();
      const launch = this.launcher!.recoverStale();
      const stuck = this.pendingFlow!.recoverStuck();
      for (const a of launch.unknown) {
        this.enqueueReply(
          a.userId,
          `⚠️ 你此前发起的「${a.workflowId}」启动结果不确定（进程中断），已转人工核对，请勿重复发起。`,
        );
      }
      // VR #12 + CV-004 同款重通知：重启后存量待审批重发审批卡（服务端确定性文案）
      for (const a of this.pendingStore!.listByStatus("pending")) {
        this.enqueueReply(a.userId, renderPendingActionApproval(a));
      }
      void rec;
      void stuck;
    }
  }

  /** WG-007：只停 Bot 与循环；运行中 Run 一律不动（可 CLI resume） */
  async stop(): Promise<void> {
    this.deps.stats?.flushSync(); // F8：优雅停止冲刷统计（未调则最多丢 5s 增量）
    this.monitor.stop();
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = undefined;
    this.agentHost?.dispose();
    await this.deps.bot.stop();
  }

  /**
   * 入站消息全链路（幂等 → 限频 → 路由/执行/任务控制 → 审计 → Outbox 回复）。
   * duplicate → 不再处理；返回供测试断言。
   */
  async handleInbound(message: BotInboundMessage): Promise<{ duplicate: boolean; reply?: string; plan?: RoutePlan }> {
    // AM-P0 §2.4：agent 分支负责到底（失败报错不重路由）；legacy 链路零改动
    if (this.deps.routingMode === "agent" && this.agentHost && this.pendingFlow) {
      return this.handleInboundAgent(message);
    }
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
        this.deps.stats?.recordTurn(out.plan.tokens ?? 0); // F8 累计 token（legacy 路由）
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

  /**
   * agent 分支入站链路：幂等 → 限频 → 确定性通道（审批决策/副作用确认词，不经 LLM）
   * → AgentHost（排队/预算/工具）。失败报错不重路由（§2.4）。
   */
  private async handleInboundAgent(
    message: BotInboundMessage,
  ): Promise<{ duplicate: boolean; reply?: string }> {
    const receipt = this.inbox.accept(message);
    if (receipt.status === "duplicate") return { duplicate: true };

    const rate = this.rateLimiter.allow(message.userId);
    if (!rate.ok) {
      this.audit.record({
        actor: message.userId,
        action: "limit.reject",
        outcome: "rejected",
        detail: `频率超限，需等待 ${rate.retryAfterSec}s`,
      });
      const reply = `请求太频繁，请 ${rate.retryAfterSec} 秒后再试。`;
      return { duplicate: false, reply };
    }

    // 1) 确定性通道：执行前授权决策（PendingAction 存在时，批准/拒绝/序号不经 LLM；AM-5/AM-13）
    const pendings = this.pendingFlow!.listFor(message.userId);
    if (pendings.length > 0) {
      const decision = parseApprovalDecision(message.text, pendings);
      if (decision?.kind === "ambiguous") {
        // 名称消歧 0/多命中：不猜，回清单要序号（避免 LLM 幻觉重提交轮换）
        const list = pendings
          .map((p, i) => `${i + 1}. ${p.workflowId}${p.resolvedTarget ? `（${p.resolvedTarget}）` : ""}`)
          .join("\n");
        this.enqueueReply(message.userId, `未匹配到唯一的待审批项，请回复「批准 序号」：\n${list}`);
        return { duplicate: false, reply: "待审批项消歧" };
      }
      if (decision && decision.kind !== "approve_all") {
        const target = pendings[decision.index]!;
        let reply: string;
        if (decision.kind === "approve") {
          const out = await this.pendingFlow!.confirm(target.actionId, message.userId);
          reply = out.ok
            ? `✅ 已批准并启动「${target.workflowId}」（任务 ${out.taskBindingId}，runId ${out.runId}）。可发「进度」查询。`
            : `⚠️ ${out.message}`;
        } else {
          const out = this.pendingFlow!.rejectAction(target.actionId, message.userId);
          reply = out.ok ? `🚫 ${out.message}` : `⚠️ ${out.message}`;
        }
        this.audit.record({
          actor: message.userId,
          action: decision.kind === "approve" ? "am.pending.approve" : "am.pending.reject",
          target: { actionId: target.actionId, workflowId: target.workflowId },
          outcome: "ok",
          detail: `待审批 ${pendings.length} 项，选中第 ${decision.index + 1} 项`,
        });
        this.enqueueReply(message.userId, reply);
        return { duplicate: false, reply };
      }
      if (decision?.kind === "approve_all") {
        // 逐项批准（每轮重拉列表；seen 护栏防 validation_failed 类失败不消费 pending 导致死循环）
        const lines: string[] = [];
        const seen = new Set<string>();
        while (true) {
          const current = this.pendingFlow!.listFor(message.userId);
          if (current.length === 0) break;
          const target = current[0]!;
          if (seen.has(target.actionId)) {
            lines.push(`⚠️ 「${target.workflowId}」反复无法批准，已跳过（可单独重试）`);
            break;
          }
          seen.add(target.actionId);
          const out = await this.pendingFlow!.confirm(target.actionId, message.userId);
          if (out.ok) {
            lines.push(`✅ 已批准并启动「${target.workflowId}」（任务 ${out.taskBindingId}，runId ${out.runId}）`);
          } else {
            lines.push(`⚠️ 「${target.workflowId}」${out.message}`);
          }
          this.audit.record({
            actor: message.userId,
            action: "am.pending.approve",
            target: { actionId: target.actionId, workflowId: target.workflowId },
            outcome: out.ok ? "ok" : "failed",
            detail: `approve_all（共 ${pendings.length} 项）`,
          });
        }
        const reply = lines.join("\n");
        this.enqueueReply(message.userId, reply);
        return { duplicate: false, reply };
      }
    }

    // 1.2) 确定性通道：任务级 checkpoint 审批（waiting_checkpoint 存在时，批准/拒绝词直通 TaskController，不经 LLM）
    // 同 PendingAction 通道同构：审批卡由 run-monitor 下发（tb 编号），决策词确定性解析，避免 LLM 误路由/重复发卡。
    if (this.taskControl.hasPendingApproval(message.userId)) {
      const verb = parseVerb(message.text);
      if (verb === "approve" || verb === "reject") {
        const out = await this.taskControl.handle(message);
        this.audit.record({
          actor: message.userId,
          action: verb === "approve" ? "checkpoint.approve" : "checkpoint.reject",
          outcome: "ok",
          detail: "任务级 checkpoint 确定性直通",
        });
        this.enqueueReply(message.userId, out.reply);
        return { duplicate: false, reply: out.reply };
      }
    }

    // 1.3) 确定性通道：工作流目录查询（「查看公众号工作流」→ 渲染 enabled 条目表格，不经 LLM）
    if (WORKFLOW_CATALOG_RE.test(message.text.replace(/\s+/g, ""))) {
      const reply = renderWorkflowCatalog(this.deps.registry.all());
      this.audit.record({
        actor: message.userId,
        action: "workflow.catalog",
        outcome: "ok",
        detail: `目录查询，enabled=${this.deps.registry.all().filter((r) => r.enabled !== false).length}`,
      });
      this.enqueueReply(message.userId, reply);
      return { duplicate: false, reply };
    }

    // 1.5) 确定性通道：URL 前置路由（设计V2 §3：域名声明命中直连 workflow，不经 Agent/LLM）。
    // 产出与 agent 工具同一形态 → facade.executeWorkflow：read-only 直启 / write 创建审批项
    //（AM-P0 链路原样生效，LLM 无自授权通路；审计 url.route.direct）。
    const urlHit = routeByUrlDirect(message.text, this.deps.registry);
    if (urlHit) {
      const out = await this.agentFacade!.executeWorkflow({
        userId: message.userId,
        workflowId: urlHit.workflowId,
        args: { [urlHit.argName]: urlHit.url },
        agentTurnId: `url-route-${randomUUID()}`,
        originMessageId: message.messageId,
      });
      if ("error" in out) {
        this.audit.record({
          actor: message.userId,
          action: "url.route.direct",
          target: { workflowId: urlHit.workflowId },
          outcome: "rejected",
          detail: out.error,
        });
        this.enqueueReply(message.userId, `⚠️ ${out.error}`);
        return { duplicate: false, reply: `⚠️ ${out.error}` };
      }
      if ("needsApproval" in out) {
        // 审批卡已由 onPendingCreated 服务端生成并入队（VR #12），此处不重复回复
        this.audit.record({
          actor: message.userId,
          action: "url.route.direct",
          target: { workflowId: urlHit.workflowId },
          outcome: "ok",
          detail: `url=${urlHit.url} → 待审批`,
        });
        return { duplicate: false, reply: "" };
      }
      this.audit.record({
        actor: message.userId,
        action: "url.route.direct",
        target: { workflowId: urlHit.workflowId },
        outcome: "ok",
        detail: `url=${urlHit.url}`,
      });
      const reply = `▶️ 已启动「${urlHit.workflowId}」（任务 ${out.taskBindingId}）。可发「进度」查询。`;
      this.enqueueReply(message.userId, reply);
      return { duplicate: false, reply };
    }

    // 2) 确定性通道：中断恢复副作用确认词（EX-009；不叫 LLM 代确认）
    const trimmed = message.text.trim();
    if (/^(确认恢复|确认继续)$/.test(trimmed)) {
      const interrupted = this.tasks
        .byUser(message.userId)
        .filter((t) => t.status === "interrupted")
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
      if (interrupted) {
        const facade = this.agentFacade!;
        const out = await facade.taskResume(message.userId, interrupted.runId, { confirmSideEffects: true });
        const reply = out.ok
          ? `▶️ 已恢复任务 ${interrupted.taskBindingId}（runId ${interrupted.runId}）。`
          : `⚠️ ${out.message}`;
        this.audit.record({
          actor: message.userId,
          action: "am.resume.confirm",
          target: { runId: interrupted.runId },
          outcome: out.ok ? "ok" : "rejected",
        });
        this.enqueueReply(message.userId, reply);
        return { duplicate: false, reply };
      }
      // 无中断任务：落入 Agent 解答
    }

    // 3) Agent 通道（§2.1：同用户排队；首条同步回执，排队走 onTurnCompleted）
    try {
      const out = await this.agentHost!.handleMessage({
        channel: "wechat",
        messageId: message.messageId,
        userId: message.userId,
        text: message.text,
        receivedAt: message.receivedAt,
      });
      if (out.status === "duplicate") return { duplicate: true };
      if (out.status === "queued") {
        const reply = "📩 已收到，正在处理上一条消息，完成后会依次回复。";
        this.enqueueReply(message.userId, reply);
        return { duplicate: false, reply };
      }
      // processed：回执已由 onTurnCompleted 统一入队发送（此处不得重复 enqueue，否则双发）
      return { duplicate: false, reply: out.result.replyText };
    } catch (error) {
      const text = `❌ 处理失败：${error instanceof Error ? error.message : String(error)}`;
      this.audit.record({ actor: message.userId, action: "am.turn.failed", outcome: "rejected", detail: text });
      this.enqueueReply(message.userId, text);
      return { duplicate: false, reply: text };
    }
  }

  /** 手动触发投递（循环到无进展为止；测试/启动补投共用） */
  async flushOutbox(): Promise<{ sent: number; failed: number; deferred: number }> {
    const totals = { sent: 0, failed: 0, deferred: 0 };
    for (let round = 0; round < 10; round += 1) {
      const pass = await this.outbox.flush(async (userId, text) => {
        await this.deps.bot.send(userId, text);
        this.deps.stats?.recordOutbound();
      });
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
    void this.outbox.flush(async (uid, text) => {
      await this.deps.bot.send(uid, text);
      this.deps.stats?.recordOutbound();
    });
  }
}

/** 确定性审批决策解析（AM-13 多项并存）
 * 支持：批准/拒绝[序号]、纯序号、都批准/全部批准、批准 <名称片段>（按 workflowId/resolvedTarget/args 消歧）、批准第N项/个。
 * 长度 >40 或无法唯一消歧 → ambiguous/undefined（ambiguous 回清单要序号；undefined 交回 Agent）。
 * 2026-10-27 真机教训：非精确「批准」（如「都批准」「批准 diagram-design」曾掉进 LLM，
 * LLM 幻觉携带 approved/approvalActionId 重新提交导致 pending 无限轮换——故此处覆盖面必须足够宽。 */
export type ApprovalDecision =
  | { kind: "approve" | "reject"; index: number }
  | { kind: "approve_all" }
  | { kind: "ambiguous" };

const APPROVAL_LEAD_FILLER = /^(?:请|麻烦|帮我|两个|三个|四个|几个|所有|全部|都|全|先)+/;
const APPROVAL_TAIL_FILLER = /(?:都|全部|所有|一下|吧|啦|了|呗)+$/;
const APPROVAL_VERBS = "批准|同意|通过|准许|approve";

export function parseApprovalDecision(
  text: string,
  pendings: readonly { workflowId: string; resolvedTarget?: string; args?: unknown }[],
): ApprovalDecision | undefined {
  const t = text.trim();
  if (!t || t.length > 80) return undefined; // 长文本（真实指令）不劫持；80 内客纳「批准 https://github.com/owner/repo」形态
  const s = t.replace(/[\s，。,.！!？?、]/g, "");
  // 1) 精确形式：动词[序号] / 拒绝动词[序号] / 纯序号
  const approve = new RegExp(`^(${APPROVAL_VERBS})([1-9]\d*)?$`, "i").exec(s);
  const reject = /^(拒绝|驳回|不同意|否决|reject)\s*([1-9]\d*)?$/i.exec(s);
  const number = /^([1-9]\d*)$/.exec(s);
  if (approve || reject || number) {
    const kind: "approve" | "reject" = reject ? "reject" : "approve";
    const n = approve?.[2] ?? reject?.[2] ?? number?.[1] ?? "1";
    const index = parseInt(n, 10) - 1;
    if (index < 0 || index >= pendings.length) return undefined; // 越界交回 Agent（无授权通路，安全）
    return { kind, index };
  }
  if (reject || number) return undefined; // 拒绝不猜意图（无副作用通路，安全）
  // 2) 都批准 / 全部批准 / 批准全部（剥离填充词后仍是纯动词）
  const base = s.replace(APPROVAL_LEAD_FILLER, "").replace(APPROVAL_TAIL_FILLER, "");
  if (new RegExp(`^(?:${APPROVAL_VERBS})$`, "i").test(base)) {
    return pendings.length > 1 ? { kind: "approve_all" } : { kind: "approve", index: 0 };
  }
  // 3) 批准 <名称片段> / <名称片段> 批准 / 批准第N项
  const m = new RegExp(`^(?:${APPROVAL_VERBS})[:：]?(.+)$`, "i").exec(s)
    ?? new RegExp(`^(.+?)(?:${APPROVAL_VERBS})$`, "i").exec(s);
  if (!m) return undefined;
  const fragment = (m[1] ?? "").replace(APPROVAL_LEAD_FILLER, "").replace(APPROVAL_TAIL_FILLER, "").replace(/第|项|个/g, "");
  if (!fragment) return undefined;
  const ordinal = /^(\d{1,2})$/.exec(fragment); // 序号形式优先（单字也在内）
  if (ordinal) {
    const index = parseInt(ordinal[1]!, 10) - 1;
    if (index < 0 || index >= pendings.length) return undefined;
    return { kind: "approve", index };
  }
  if (fragment.length < 2) return undefined; // 名称片段至少 2 字，避免噪声
  if (fragment.length > 40) return undefined; // 「批准 + 长指令」是真实意图，交回 Agent，不劫持
  const needle = fragment.toLowerCase().replace(/[\s.,，。]/g, "");
  const hitIdx: number[] = [];
  pendings.forEach((p, i) => {
    const hay = `${p.workflowId} ${p.resolvedTarget ?? ""} ${JSON.stringify(p.args ?? {})}`
      .toLowerCase()
      .replace(/[\s.,，。]/g, "");
    if (hay.includes(needle)) hitIdx.push(i);
  });
  if (hitIdx.length === 1) return { kind: "approve", index: hitIdx[0]! };
  if (hitIdx.length > 1) return { kind: "ambiguous" }; // 多命中：回清单要序号，不猜
  // 0 命中：短片段（像名称拼写不一致）→ 回清单要序号；长片段（像真实指令）交回 Agent
  return fragment.length <= 12 ? { kind: "ambiguous" } : undefined;
}
