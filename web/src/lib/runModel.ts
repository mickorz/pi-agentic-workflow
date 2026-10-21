/**
 * Run 事件流 → UI 模型（P2-04 核心纯函数；P2-05 useRunEvents 复用喂 SSE 帧）。
 *
 * 约束：
 * - 事件按 sequence 单调应用；重复/乱序（sequence <= lastSequence）直接忽略（幂等去重）。
 * - null 业务结果不误判失败：node 状态只由事件决定（node.completed 即成功，无论结果值）。
 */

export type NodeStatus = "running" | "ok" | "failed" | "replayed";

export interface NodeModel {
  id: string;
  label: string;
  phase: string;
  status: NodeStatus;
  attempt: number;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string;
  sessionId?: string;
  /** 嵌套 workflow 的组合路径（如 ["root","子流程名"]） */
  compositePath?: string[];
  scopePath?: string[];
}

export interface PhaseModel {
  title: string;
  nodeIds: string[];
}

export interface TimelineItem {
  sequence: number;
  timestamp: string;
  type: string;
  nodeId?: string;
  attempt?: number;
  summary: string;
}

export interface RunModel {
  lastSequence: number;
  runStatus?: "completed" | "failed" | "cancelled";
  runError?: string;
  agentCount?: number;
  phases: PhaseModel[];
  nodes: Record<string, NodeModel>;
  nodeOrder: string[];
  logs: string[];
  timeline: TimelineItem[];
}

export const NO_PHASE = "（未分阶段）";

export function emptyRunModel(): RunModel {
  return { lastSequence: 0, phases: [], nodes: {}, nodeOrder: [], logs: [], timeline: [] };
}

function phaseOf(model: RunModel, title: string): PhaseModel {
  let p = model.phases.find((x) => x.title === title);
  if (!p) {
    p = { title, nodeIds: [] };
    model.phases.push(p);
  }
  return p;
}

function ensureNode(model: RunModel, nodeId: string, label: string, phase: string): NodeModel {
  let n = model.nodes[nodeId];
  if (!n) {
    n = { id: nodeId, label, phase, status: "running", attempt: 1 };
    model.nodes[nodeId] = n;
    model.nodeOrder.push(nodeId);
    phaseOf(model, phase).nodeIds.push(nodeId);
  }
  return n;
}

function durationMs(from?: string, to?: string): number | undefined {
  if (!from || !to) return undefined;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return undefined;
  return Math.max(0, b - a);
}

/** payload 宽松读取（事件体字段有限且稳定，避免每类型精确建模） */
function p(ev: RunEventLike): Record<string, unknown> {
  return (ev.payload ?? {}) as Record<string, unknown>;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function strArr(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
}

export interface RunEventLike {
  sequence: number;
  timestamp?: string;
  at?: string;
  type: string;
  nodeId?: string;
  attempt?: number;
  payload?: unknown;
}

function summaryFor(ev: RunEventLike): string {
  const d = p(ev);
  switch (ev.type) {
    case "run.started":
      return `run 启动（${str(d.name) ?? "root"}）`;
    case "run.completed":
      return `run 完成（agentCount=${String(d.agentCount ?? "?")}）`;
    case "run.failed":
      return `run 失败：${str(d.error) ?? "?"}`;
    case "run.cancelled":
      return `run 已取消`;
    case "phase.started":
      return `阶段开始：${str(d.title) ?? "?"}`;
    case "node.started":
      return `节点开始：${str(d.label) ?? ev.nodeId ?? "?"}`;
    case "node.completed":
      return `节点完成：${str(d.label) ?? ev.nodeId ?? "?"}${ev.attempt && ev.attempt > 1 ? `（第 ${ev.attempt} 次）` : ""}`;
    case "node.failed":
      return `节点失败：${str(d.label) ?? ev.nodeId ?? "?"}——${str(d.error) ?? "?"}`;
    case "node.replayed":
      return `节点回放（journal 命中，不重跑）：${str(d.label) ?? ev.nodeId ?? "?"}`;
    case "agent.session.created":
      return `会话创建：${str(d.sessionId) ?? "?"}`;
    case "checkpoint.requested":
      return `等待审批：${str(d.question) ?? ""}`;
    case "checkpoint.resolved":
      return `审批完成：${str(d.decision) ?? String(d.status ?? "")}`;
    case "log.appended":
      return str(d.message) ?? "log";
    default:
      return ev.type;
  }
}

/** 单事件应用（原地修改 model，调用方负责副本语义）；重复/过期事件被忽略 */
export function applyEvent(model: RunModel, ev: RunEventLike): RunModel {
  if (ev.sequence <= model.lastSequence) return model;
  model.lastSequence = ev.sequence;
  const timestamp = ev.timestamp ?? ev.at ?? "";
  model.timeline.push({
    sequence: ev.sequence,
    timestamp,
    type: ev.type,
    nodeId: ev.nodeId,
    attempt: ev.attempt,
    summary: summaryFor(ev),
  });

  const d = p(ev);
  switch (ev.type) {
    case "run.started":
      break;
    case "run.completed":
      model.runStatus = "completed";
      model.agentCount = typeof d.agentCount === "number" ? d.agentCount : undefined;
      break;
    case "run.failed":
      model.runStatus = "failed";
      model.runError = str(d.error);
      break;
    case "run.cancelled":
      model.runStatus = "cancelled";
      break;
    case "phase.started": {
      const title = str(d.title);
      if (title) phaseOf(model, title);
      break;
    }
    case "node.started": {
      const nodeId = ev.nodeId ?? "?";
      const n = ensureNode(model, nodeId, str(d.label) ?? nodeId, str(d.phase) ?? NO_PHASE);
      n.status = "running";
      n.attempt = ev.attempt ?? n.attempt;
      n.startedAt = timestamp;
      n.finishedAt = undefined;
      n.durationMs = undefined;
      n.error = undefined;
      const cp = strArr(d.compositePath);
      if (cp) n.compositePath = cp;
      const sp = strArr(d.workflowScopePath);
      if (sp) n.scopePath = sp;
      break;
    }
    case "agent.session.created": {
      const nodeId = ev.nodeId;
      if (nodeId && model.nodes[nodeId]) model.nodes[nodeId]!.sessionId = str(d.sessionId);
      break;
    }
    case "node.replayed": {
      const nodeId = ev.nodeId ?? "?";
      const n = ensureNode(model, nodeId, str(d.label) ?? nodeId, str(d.phase) ?? NO_PHASE);
      n.status = "replayed";
      n.attempt = ev.attempt ?? n.attempt;
      n.finishedAt = timestamp;
      break;
    }
    case "node.completed": {
      const nodeId = ev.nodeId ?? "?";
      const n = ensureNode(model, nodeId, str(d.label) ?? nodeId, str(d.phase) ?? NO_PHASE);
      n.status = "ok";
      n.attempt = ev.attempt ?? n.attempt;
      n.finishedAt = timestamp;
      n.durationMs = durationMs(n.startedAt, timestamp) ?? n.durationMs;
      break;
    }
    case "node.failed": {
      const nodeId = ev.nodeId ?? "?";
      const n = ensureNode(model, nodeId, str(d.label) ?? nodeId, str(d.phase) ?? NO_PHASE);
      n.status = "failed";
      n.attempt = ev.attempt ?? n.attempt;
      n.error = str(d.error);
      n.finishedAt = timestamp;
      n.durationMs = durationMs(n.startedAt, timestamp) ?? n.durationMs;
      break;
    }
    case "log.appended": {
      const m = str(d.message);
      if (m) model.logs.push(m);
      break;
    }
    default:
      break; // checkpoint.requested/resolved 等：时间线已记录，面板在 P2-06 实装
  }
  return model;
}

export function applyEvents(model: RunModel, events: RunEventLike[]): RunModel {
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence);
  for (const ev of sorted) applyEvent(model, ev);
  return model;
}

/** 终态用量摘要（来自 result.json 的 AgentRecord；仅终态可得） */
export interface UsageSummary {
  agentCount: number;
  durationMs: number;
  tokens?: number;
  cost?: number;
  perNode: Record<string, { tokens?: number; cost?: number; durationMs?: number; model?: string; maxAttempts?: number }>;
}

export function usageFromSnapshot(snapshot: { result?: unknown } | undefined): UsageSummary | null {
  const r = snapshot?.result as
    | { agentCount?: number; durationMs?: number; agents?: Array<{ id: string; tokens?: number; cost?: number; durationMs?: number; model?: string; maxAttempts?: number }> }
    | undefined;
  if (!r || typeof r !== "object" || !Array.isArray(r.agents)) return null;
  const perNode: UsageSummary["perNode"] = {};
  let tokens = 0;
  let cost = 0;
  let hasTokens = false;
  for (const a of r.agents) {
    perNode[a.id] = { tokens: a.tokens, cost: a.cost, durationMs: a.durationMs, model: a.model, maxAttempts: a.maxAttempts };
    if (typeof a.tokens === "number") {
      tokens += a.tokens;
      hasTokens = true;
    }
    if (typeof a.cost === "number") cost += a.cost;
  }
  return {
    agentCount: typeof r.agentCount === "number" ? r.agentCount : r.agents.length,
    durationMs: typeof r.durationMs === "number" ? r.durationMs : 0,
    ...(hasTokens ? { tokens } : {}),
    ...(cost > 0 ? { cost } : {}),
    perNode,
  };
}
