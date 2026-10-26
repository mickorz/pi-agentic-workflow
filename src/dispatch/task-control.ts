/**
 * Task Control（IR-008/009，EX-005~009，A13/A14，A11/A12 审批面，A16 恢复面）：
 *  - 意图分发：Dispatcher 收到 intent=task_control 后交给本模块（不再进 Workflow 路由）
 *  - 规则动词解析（查询/取消/恢复/批准/拒绝/列表），不依赖 LLM，确定性可测
 *  - 用户归属过滤（EX-006：不得误操作他人 Run）
 *  - 歧义澄清（IR-009：多个候选必须先澄清，绝不默认操作）
 *  - 审批走 decideCheckpoint(expectedVersion)：重复幂等、版本冲突拒绝、跨用户拒绝（A12）
 *  - 恢复沿用 service.resume 语义：副作用需显式确认（EX-009），确认词「确认恢复」
 */

import type { AuditLog } from "../audit/audit-log.js";
import type { BotInboundMessage, TaskBinding } from "../contracts/wx.js";
import type { TaskStore } from "./task-store.js";

export interface TaskControlCheckpoint {
  checkpointId: string;
  nodeId: string;
  question: string;
  status: "pending" | "approved" | "rejected";
  version: number;
}

/** RunApplicationService 的结构化子集（生产直传；测试 fake） */
export interface TaskControlService {
  get(runId: string): Promise<{
    snapshot: { status: string; effectiveStatus: string; result?: unknown; manifest?: { error?: string } | null };
    checkpoints: TaskControlCheckpoint[];
  } | null>;
  cancel(runId: string): Promise<unknown>;
  resume(runId: string, options: { acknowledgeSideEffects: boolean }): Promise<unknown>;
  decideCheckpoint(
    runId: string,
    checkpointId: string,
    input: { decision: "approve" | "reject"; expectedVersion: number },
  ): Promise<unknown>;
}

export interface TaskControllerDeps {
  tasks: TaskStore;
  service: TaskControlService;
  audit?: AuditLog;
}

type Verb = "approve" | "reject" | "cancel" | "resume" | "list" | "status" | "unknown";
type Ref = { kind: "latest" } | { kind: "id"; value: string } | undefined;

const ACTIVE_STATUSES = new Set(["running", "waiting_checkpoint", "interrupted"]);
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export class TaskController {
  constructor(private readonly deps: TaskControllerDeps) {}

  /** 该用户是否存在等待审批的任务（dispatcher 审批决策确定性直通判定用） */
  hasPendingApproval(userId: string): boolean {
    return this.deps.tasks.byUser(userId).some((b) => b.status === "waiting_checkpoint");
  }

  /** 入口（由 Dispatcher 在 intent=task_control 时调用） */
  async handle(message: BotInboundMessage): Promise<{ reply: string }> {
    const text = message.text;
    const verb = parseVerb(text);
    switch (verb) {
      case "approve":
      case "reject": {
        // 批量决策（「批准 2 拒绝 1」）：按澄清列表快照逐项执行；非批量返回 null 回退单决策
        const multi = await this.decideMulti(message.userId, text);
        if (multi !== null) return { reply: multi };
        return { reply: await this.decide(message.userId, verb === "approve" ? "approve" : "reject", text) };
      }
      case "cancel":
        return { reply: await this.cancel(message.userId, text) };
      case "resume":
        return { reply: await this.resume(message.userId, text) };
      case "list":
        return { reply: await this.list(message.userId) };
      case "status":
        return { reply: await this.status(message.userId, text) };
      default:
        return { reply: "支持的任务指令：任务列表 / 进度如何 / 取消任务 / 恢复任务 / 批准 / 拒绝" };
    }
  }

  // ── 列表（EX-005 + NT-006 主动查询补偿） ──

  async list(userId: string): Promise<string> {
    const mine = this.deps.tasks.byUser(userId);
    if (mine.length === 0) return "你还没有任务。可说「分析 <github 仓库地址>」发起一个。";
    const sorted = [...mine].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const lines: string[] = ["📋 你的任务："];
    for (const b of sorted.slice(0, 10)) {
      const live = await this.liveStatus(b);
      lines.push(`• ${b.taskBindingId}（${b.workflowId}）— ${statusText(live)}`);
      if (TERMINAL.has(live) && b.summary) lines.push(`  摘要：${truncate(b.summary, 120)}`);
    }
    if (sorted.length > 10) lines.push(`…共 ${sorted.length} 个任务`);
    return lines.join("\n");
  }

  // ── 状态查询（A13） ──

  async status(userId: string, text: string): Promise<string> {
    const target = await this.resolveTarget(userId, parseRef(text));
    if (typeof target === "string") return target;
    const { binding } = target;
    const detail = await this.deps.service.get(binding.runId);
    const eff = detail?.snapshot.effectiveStatus ?? binding.status;
    const lines = [`任务 ${binding.taskBindingId}（${binding.workflowId}）`, `状态：${statusText(eff)}`];
    const pending = detail?.checkpoints.filter((c) => c.status === "pending") ?? [];
    if (pending.length > 0 && pending[0]) lines.push(`⏳ 等待审批：${pending[0].question}（回复「批准」或「拒绝」）`);
    if (TERMINAL.has(eff) && binding.summary) lines.push(`摘要：${truncate(binding.summary, 300)}`);
    return lines.join("\n");
  }

  // ── 取消（EX-006，A13） ──

  async cancel(userId: string, text: string): Promise<string> {
    const target = await this.resolveTarget(userId, parseRef(text));
    if (typeof target === "string") return target;
    const { binding } = target;
    if (TERMINAL.has(binding.status)) {
      return `任务 ${binding.taskBindingId} 已是终态（${statusText(binding.status)}），无需取消。`;
    }
    try {
      await this.deps.service.cancel(binding.runId);
    } catch (error) {
      return `取消失败：${errorCode(error) ?? errorMessage(error)}`;
    }
    this.deps.tasks.update(binding.runId, { status: "cancelled" });
    this.deps.audit?.record({
      actor: userId,
      action: "run.cancel",
      target: { runId: binding.runId, taskBindingId: binding.taskBindingId, workflowId: binding.workflowId },
      outcome: "ok",
    });
    return `🛑 已取消任务 ${binding.taskBindingId}。`;
  }

  // ── 恢复（EX-009，A16：副作用显式确认） ──

  async resume(userId: string, text: string): Promise<string> {
    const confirmed = /确认恢复|确认继续/.test(text);
    const target = await this.resolveTarget(userId, parseRef(text));
    if (typeof target === "string") return target;
    const { binding } = target;

    // 等待审批的任务：引导审批而非 resume
    const detail = await this.deps.service.get(binding.runId);
    const pending = detail?.checkpoints.filter((c) => c.status === "pending") ?? [];
    if (pending.length > 0) {
      return pending[0] ? `任务在等待审批：${pending[0].question}\n请回复「批准」或「拒绝」。` : "任务在等待审批。";
    }
    if (binding.status === "completed") return "任务已完成，无需恢复。";

    const attempt = async (ack: boolean) => this.deps.service.resume(binding.runId, { acknowledgeSideEffects: ack });
    try {
      await attempt(false);
    } catch (error) {
      const code = errorCode(error);
      if (code === "SIDE_EFFECTS_UNACKNOWLEDGED") {
        if (!confirmed) {
          return (
            `⚠️ 恢复可能重复执行中断前未记入 Journal 的副作用。\n` +
            `确认已了解风险请回复：「确认恢复 ${binding.taskBindingId}」`
          );
        }
        try {
          await attempt(true);
        } catch (e2) {
          return `恢复失败：${errorCode(e2) ?? errorMessage(e2)}`;
        }
      } else if (code === "RUN_STILL_ACTIVE") {
        return "任务仍在运行中，无需恢复。";
      } else if (code === "CONFLICT") {
        return "任务已完成，不能恢复。";
      } else {
        return `恢复失败：${code ?? errorMessage(error)}`;
      }
    }
    this.deps.tasks.update(binding.runId, { status: "running" });
    this.deps.audit?.record({
      actor: userId,
      action: "run.resume",
      target: { runId: binding.runId, taskBindingId: binding.taskBindingId, workflowId: binding.workflowId },
      outcome: "ok",
      detail: confirmed ? "interrupted 恢复（用户显式确认副作用）" : "waiting 恢复",
    });
    return `▶️ 已恢复任务 ${binding.taskBindingId}。`;
  }

  // ── 审批（EX-007/008，A11/A12，SC-006） ──

  // ── 批量审批：「批准 2 拒绝 1 tb-xxx」一条消息多段操作，序号按澄清列表快照解析 ──

  /** 解析多段决策；少于 2 段返回 null（单决策走 decide 原路径） */
  private parseDecisionOps(
    text: string,
  ): Array<{ decision: "approve" | "reject"; target: string }> | null {
    const ops: Array<{ decision: "approve" | "reject"; target: string }> = [];
    const re = /(批准|同意|通过|准许|approve|拒绝|驳回|不同意|否决|reject)\s*(tb-[0-9a-zA-Z-]+|[1-9]\d*)?/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const verb = m[1] ?? "";
      const decision: "approve" | "reject" = /^(拒绝|驳回|不同意|否决|reject)/i.test(verb)
        ? "reject"
        : "approve";
      ops.push({ decision, target: m[2] ?? "" });
    }
    return ops.length >= 2 ? ops : null;
  }

  async decideMulti(userId: string, text: string): Promise<string | null> {
    const ops = this.parseDecisionOps(text);
    if (!ops) return null;

    // 快照：与澄清列表同序展开 pending（批量内序号不随执行位移）
    const mine = this.deps.tasks.byUser(userId);
    let candidates = mine.filter((b) => b.status === "waiting_checkpoint");
    if (candidates.length === 0) {
      for (const b of mine) {
        const detail = await this.deps.service.get(b.runId);
        if ((detail?.checkpoints ?? []).some((c) => c.status === "pending")) candidates = [...candidates, b];
      }
    }
    const pending: Array<{ binding: TaskBinding; checkpoint: TaskControlCheckpoint }> = [];
    for (const b of candidates) {
      const detail = await this.deps.service.get(b.runId);
      for (const cp of detail?.checkpoints ?? []) {
        if (cp.status === "pending") pending.push({ binding: b, checkpoint: cp });
      }
    }
    if (pending.length === 0) return "当前没有等待你审批的任务。";

    const lines: string[] = [];
    for (const op of ops) {
      let chosen: (typeof pending)[number] | undefined;
      if (op.target.startsWith("tb-")) {
        chosen = pending.find((p) => p.binding.taskBindingId === op.target);
      } else if (/^[1-9]\d*$/.test(op.target)) {
        chosen = pending[Number(op.target) - 1];
      } else if (pending.length === 1) {
        chosen = pending[0]; // 无目标且唯一候选：允许（「批准 拒绝」作用于同项时第二段走幂等话术）
      }
      const label = op.decision === "approve" ? "批准" : "拒绝";
      if (!chosen) {
        lines.push(`× ${label} ${op.target || "(未指定)"}：未找到对应待审批项（可选 1-${pending.length}）`);
        continue;
      }
      lines.push(
        `• ${label} ${chosen.binding.taskBindingId}：${await this.applyDecision(userId, op.decision, chosen.binding, chosen.checkpoint)}`,
      );
    }
    return lines.join("\n");
  }

  async decide(userId: string, decision: "approve" | "reject", text: string): Promise<string> {
    // 候选：名下处于等待审批态的任务（含已决未扫拍——用于幂等/冲突话术）
    const mine = this.deps.tasks.byUser(userId);
    const ref = parseRef(text);
    const index = parseApprovalIndex(text); // 序号选择（歧义澄清后回复「批准 2」或纯「2」）
    let candidates: TaskBinding[] = [];
    if (ref?.kind === "id") {
      const binding = this.findById(mine, ref.value);
      if (!binding) {
        // 归属校验（EX-006/A12c）：目标存在但不属于该用户 → 拒绝
        const foreign = this.findById(this.deps.tasks.list(), ref.value);
        if (foreign) {
          this.deps.audit?.record({
            actor: userId,
            action: decision === "approve" ? "checkpoint.approve" : "checkpoint.reject",
            target: { runId: foreign.runId, taskBindingId: foreign.taskBindingId },
            outcome: "rejected",
            detail: "跨用户审批被拒绝",
          });
          return "无权操作他人的任务。";
        }
        return `未找到任务：${ref.value}`;
      }
      candidates = [binding];
    } else {
      candidates = mine.filter((b) => b.status === "waiting_checkpoint");
      if (candidates.length === 0) {
        // 无等待审批态绑定：再探一次是否存在 pending checkpoint（状态尚未同步）
        for (const b of mine) {
          const detail = await this.deps.service.get(b.runId);
          if ((detail?.checkpoints ?? []).some((c) => c.status === "pending")) candidates.push(b);
        }
      }
    }

    const pending: Array<{ binding: TaskBinding; checkpoint: TaskControlCheckpoint }> = [];
    const decided: Array<{ binding: TaskBinding; checkpoint: TaskControlCheckpoint }> = [];
    for (const b of candidates) {
      const detail = await this.deps.service.get(b.runId);
      for (const cp of detail?.checkpoints ?? []) {
        (cp.status === "pending" ? pending : decided).push({ binding: b, checkpoint: cp });
      }
    }
    if (pending.length === 0 && decided.length === 0) return "当前没有等待你审批的任务。";
    // 序号选择（歧义澄清后）：按澄清列表同序取第 N 项
    if (index !== null) {
      const chosen = pending[index - 1];
      if (!chosen) return `序号超出范围（1-${pending.length}），请回复列表中的序号。`;
      return this.applyDecision(userId, decision, chosen.binding, chosen.checkpoint);
    }
    if (pending.length > 1) {
      // IR-009：多个待审批先澄清（序号制，免复制长任务号）
      const verb = decision === "approve" ? "批准" : "拒绝";
      const lines = ["有多个待审批项，请回复序号选择："];
      pending.forEach(({ binding, checkpoint }, i) => {
        lines.push(`• [${i + 1}] ${binding.taskBindingId} — ${checkpoint.question}（回复「${verb} ${i + 1}」或「${verb} ${binding.taskBindingId}」）`);
      });
      return lines.join("\n");
    }
    // A12a：无 pending 但存在已决项 → 幂等/冲突话术（不再触碰执行侧）
    const chosen = pending[0] ?? decided[0];
    if (!chosen) return "当前没有等待你审批的任务。";
    return this.applyDecision(userId, decision, chosen.binding, chosen.checkpoint);
  }

  private async applyDecision(
    userId: string,
    decision: "approve" | "reject",
    binding: TaskBinding,
    checkpoint: TaskControlCheckpoint,
  ): Promise<string> {
    const action = decision === "approve" ? "checkpoint.approve" : "checkpoint.reject";
    const label = decision === "approve" ? "批准" : "拒绝";
    // A12a 幂等：重复同义审批 → 不再调用执行侧
    if (checkpoint.status === "approved") {
      return decision === "approve" ? "该审批已批准过，任务正在继续，无需重复操作。" : "该审批已被批准，不能再拒绝。";
    }
    if (checkpoint.status === "rejected") {
      return decision === "reject" ? "该审批已拒绝过，任务已停止。" : "该审批已被拒绝，不能再批准。";
    }
    try {
      await this.deps.service.decideCheckpoint(binding.runId, checkpoint.checkpointId, {
        decision,
        expectedVersion: checkpoint.version,
      });
    } catch (error) {
      const code = errorCode(error);
      this.deps.audit?.record({
        actor: userId,
        action,
        target: {
          runId: binding.runId,
          taskBindingId: binding.taskBindingId,
          checkpointId: checkpoint.checkpointId,
          version: checkpoint.version,
        },
        outcome: "rejected",
        detail: `决策被拒绝：${code ?? errorMessage(error)}`,
      });
      if (code === "CONFLICT") return "该审批已被处理或版本已变化，未重复推进。可发「进度如何」查看最新状态。";
      if (code === "CHECKPOINT_NOT_PENDING") return "该审批已处理完毕，请勿重复操作。";
      return `审批失败：${code ?? errorMessage(error)}`;
    }
    this.deps.audit?.record({
      actor: userId,
      action,
      target: {
        runId: binding.runId,
        taskBindingId: binding.taskBindingId,
        checkpointId: checkpoint.checkpointId,
        version: checkpoint.version,
      },
      outcome: "ok",
      detail: checkpoint.question,
    });
    return decision === "approve"
      ? `✅ 已批准（${binding.taskBindingId}），任务继续执行。`
      : `🛑 已拒绝（${binding.taskBindingId}），任务按拒绝语义停止。`;
  }

  // ── 目标解析（IR-009 歧义澄清 + EX-006 归属） ──

  private async resolveTarget(userId: string, ref: Ref): Promise<{ binding: TaskBinding } | string> {
    const mine = this.deps.tasks.byUser(userId);
    if (ref?.kind === "id") {
      const own = this.findById(mine, ref.value);
      if (own) return { binding: own };
      const foreign = this.findById(this.deps.tasks.list(), ref.value);
      if (foreign) return "无权操作他人的任务。";
      return `未找到任务：${ref.value}`;
    }
    if (ref?.kind === "latest") {
      const latest = this.deps.tasks.latestByUser(userId);
      if (!latest) return "你还没有任务。";
      return { binding: latest };
    }
    const active = mine.filter((b) => ACTIVE_STATUSES.has(b.status));
    if (active.length === 0) return "没有进行中的任务。可发「任务列表」查看全部。";
    const single = active[0];
    if (active.length === 1 && single) return { binding: single };
    // A14：多个候选必须澄清
    const lines = ["有多个进行中的任务，请指明要操作哪一个："];
    for (const b of active) lines.push(`• ${b.taskBindingId}（${b.workflowId}，${statusText(b.status)}）`);
    lines.push("例如：取消任务 tb-xxxxxxxx");
    return lines.join("\n");
  }

  private findById(bindings: TaskBinding[], id: string): TaskBinding | undefined {
    const lower = id.toLowerCase();
    return (
      bindings.find((b) => b.taskBindingId.toLowerCase() === lower || b.runId.toLowerCase() === lower) ??
      bindings.find((b) => b.taskBindingId.toLowerCase().startsWith(lower) || b.runId.toLowerCase().startsWith(lower))
    );
  }

  private async liveStatus(binding: TaskBinding): Promise<string> {
    const detail = await this.deps.service.get(binding.runId);
    return detail?.snapshot.effectiveStatus ?? binding.status;
  }
}

// ── 文本解析（确定性规则，不依赖 LLM） ──

/** 歧义澄清后的序号选择：「批准 2」「拒绝 3」或纯「2」→ 序号（>=1）；不匹配返回 null */
export function parseApprovalIndex(text: string): number | null {
  const t = text.trim();
  if (/^[1-9]\d*$/.test(t)) return Number(t);
  const m = t.match(/^(?:批准|同意|通过|准许|拒绝|驳回|不同意|否决|approve|reject)[^0-9]{0,4}([1-9]\d*)\s*$/i);
  return m ? Number(m[1]) : null;
}

export function parseVerb(text: string): Verb {
  const t = text.trim();
  if (/^(批准|同意|通过|准许|approve)|.{0,12}(批准|同意审批|通过审批)/i.test(t) || /^approve\b/i.test(t))
    return "approve";
  if (/^(拒绝|驳回|不同意|否决|reject)|.{0,12}(拒绝|驳回)/.test(t) || /^reject\b/i.test(t)) return "reject";
  if (/(取消|终止|停掉|中止).{0,8}(任务|run)|(任务|run).{0,6}(取消|终止|停掉)|^cancel\b/i.test(t)) return "cancel";
  if (/确认恢复|确认继续|(恢复|继续|resume)/i.test(t)) return "resume";
  if (/任务列表|查看任务|我的任务|列出任务|查.{0,2}任务|任务.{0,2}清单/.test(t)) return "list";
  if (/进度|状态|怎么样|执行.{0,4}(如何|怎样)|查询|查一下|status/i.test(t)) return "status";
  return "unknown";
}

/** 引用解析：显式 id（tb-/run 前缀或长十六进制）或「刚才/最近」 */
export function parseRef(text: string): Ref {
  const t = text.trim();
  const idMatch = t.match(/\b((?:tb-)?[0-9a-f]{6,}(?:-[0-9a-f]{4}){0,3})\b/i);
  const id = idMatch?.[1];
  if (id && ((/tb-|run/.test(t) && id.length >= 6) || id.length >= 12)) return { kind: "id", value: id };
  if (/刚才|刚刚|最近|上次|latest/i.test(t)) return { kind: "latest" };
  return undefined;
}

function statusText(status: string): string {
  const map: Record<string, string> = {
    running: "运行中",
    waiting_checkpoint: "等待审批",
    interrupted: "已中断（可恢复）",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  return map[status] ?? status;
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
