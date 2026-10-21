/**
 * Run Monitor（EX-007 触发面，NT-004 入队面，CV-004 重启扫描）：
 *  - 轮询 TaskStore 中活跃绑定（running / waiting_checkpoint）的真实 Run 状态
 *  - waiting_checkpoint + pending checkpoint → 经 Outbox 发审批卡片（版本去重，重启不重发旧版本）
 *  - 终态 → 完成摘要 / 失败 / 取消通知入队 + TaskBinding 状态同步（完成≠送达，§9.3）
 *  - interrupted → 绑定状态同步 + 可恢复提示
 *  - 纯轮询实现（进程内低频），不侵入 engine/service；pollOnce 供测试与启动期补扫
 */

import type { AuditLog } from "../audit/audit-log.js";
import type { TaskBinding } from "../contracts/wx.js";
import type { Outbox } from "../notify/outbox.js";
import type { TaskControlCheckpoint, TaskControlService } from "./task-control.js";
import type { TaskStore } from "./task-store.js";

export interface RunMonitorDeps {
  tasks: TaskStore;
  service: TaskControlService;
  outbox: Outbox;
  audit?: AuditLog;
  /** 轮询间隔（缺省 3000ms） */
  pollMs?: number;
  /** AM-P0 §5：Run 终态回写 run-links（后续 Turn 的 task_status 读真实产物；结构化接口避免反向依赖） */
  runLinks?: RunLinkSink;
}

/** run-links 行（agent-host RunLink 的结构化子集；生产可直接传入，无反向依赖） */
export interface RunLinkRow {
  runId: string;
  taskBindingId?: string;
  agentTurnId?: string;
  conversationId?: string;
  status: string;
  resultSummary?: string;
  resultRef?: string;
  attemptId?: string;
}

export interface RunLinkSink {
  get(runId: string): RunLinkRow | undefined;
  upsert(link: RunLinkRow): unknown;
}

export class RunMonitor {
  private timer?: NodeJS.Timeout;

  constructor(private readonly deps: RunMonitorDeps) {}

  start(): void {
    const pollMs = this.deps.pollMs ?? 3000;
    this.stop();
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 单轮扫描（测试直接调用；启动时也先跑一轮做重启补扫） */
  async pollOnce(): Promise<void> {
    for (const binding of this.deps.tasks.list()) {
      if (binding.status !== "running" && binding.status !== "waiting_checkpoint") continue;
      const detail = await this.deps.service.get(binding.runId);
      if (!detail) continue;
      const eff = detail.snapshot.effectiveStatus;
      if (eff === "waiting_checkpoint") {
        await this.notifyCheckpointIfNeeded(binding, detail.checkpoints);
      } else if (binding.status === "waiting_checkpoint" && eff === "running") {
        // 审批已决：绑定回 running（checkpoint.resolved 语义）
        this.deps.tasks.update(binding.runId, { status: "running" });
      } else if (eff === "completed") {
        const summary = summarizeResult(detail.snapshot.result);
        this.deps.tasks.update(binding.runId, { status: "completed", summary });
        this.writeRunLink(binding, "completed", summary);
        this.deps.outbox.enqueue({
          userId: binding.userId,
          kind: "completed",
          runId: binding.runId,
          taskBindingId: binding.taskBindingId,
          text: `🎉「${binding.workflowId}」已完成（${binding.taskBindingId}）：\n${summary}`,
        });
      } else if (eff === "failed") {
        this.deps.tasks.update(binding.runId, { status: "failed" });
        this.writeRunLink(binding, "failed");
        this.deps.outbox.enqueue({
          userId: binding.userId,
          kind: "failed",
          runId: binding.runId,
          taskBindingId: binding.taskBindingId,
          text: `❌「${binding.workflowId}」失败（${binding.taskBindingId}）。可发「进度如何 tb…」查看详情。`,
        });
      } else if (eff === "cancelled") {
        this.deps.tasks.update(binding.runId, { status: "cancelled" });
        this.writeRunLink(binding, "cancelled");
      } else if (eff === "interrupted") {
        this.deps.tasks.update(binding.runId, { status: "interrupted" });
        this.writeRunLink(binding, "interrupted");
        this.deps.outbox.enqueue({
          userId: binding.userId,
          kind: "interrupted",
          runId: binding.runId,
          taskBindingId: binding.taskBindingId,
          text: `⚠️「${binding.workflowId}」（${binding.taskBindingId}）已中断。可回复「恢复任务」继续（涉及副作用时需显式确认）。`,
        });
      }
    }
  }

  /** §5：终态回写 run-links（合并保留既有 attemptId/agentTurnId 关联字段） */
  private writeRunLink(binding: TaskBinding, status: string, resultSummary?: string): void {
    const sink = this.deps.runLinks;
    if (!sink) return;
    const prev = sink.get(binding.runId);
    sink.upsert({
      ...(prev ?? {}),
      runId: binding.runId,
      taskBindingId: binding.taskBindingId,
      status,
      ...(resultSummary !== undefined ? { resultSummary } : {}),
    });
  }

  /** 审批卡通知：同版本只发一次（A11）；resume 后版本自增 → 新卡 */
  private async notifyCheckpointIfNeeded(binding: TaskBinding, checkpoints: TaskControlCheckpoint[]): Promise<void> {
    const pending = checkpoints.filter((c) => c.status === "pending");
    if (pending.length === 0) {
      // 全部已决：绑定回 running 由 monitor 下一轮生效（engine resolved 事件为准）
      return;
    }
    const cp = pending[0];
    if (!cp) return;
    if (binding.approvalNotifiedVersion === cp.version) return; // 已通知过该版本
    this.deps.tasks.update(binding.runId, { status: "waiting_checkpoint", approvalNotifiedVersion: cp.version });
    this.deps.audit?.record({
      actor: "system",
      action: "checkpoint.requested",
      target: {
        runId: binding.runId,
        taskBindingId: binding.taskBindingId,
        workflowId: binding.workflowId,
        checkpointId: cp.checkpointId,
        version: cp.version,
      },
      detail: `审批卡已发送：${cp.question}`,
    });
    this.deps.outbox.enqueue({
      userId: binding.userId,
      kind: "approval",
      runId: binding.runId,
      taskBindingId: binding.taskBindingId,
      text: renderApprovalCard(binding, cp),
    });
  }
}

/** 审批卡片（EX-007：含任务标识与内容摘要 + 指引用语） */
export function renderApprovalCard(binding: TaskBinding, cp: TaskControlCheckpoint): string {
  return [
    "⏳ 任务等待你的审批",
    `任务：${binding.taskBindingId}（${binding.workflowId}）`,
    `事项：${cp.question}`,
    "",
    "回复「批准」继续执行；回复「拒绝」停止。",
  ].join("\n");
}

function summarizeResult(result: unknown): string {
  if (result === null || result === undefined) return "（无返回值）";
  const text = typeof result === "string" ? result : JSON.stringify(result);
  return text.length <= 500 ? text : `${text.slice(0, 500)}…`;
}
