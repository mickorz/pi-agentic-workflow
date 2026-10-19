/**
 * Workflow Runtime —— 宿主无关的编排核心（P1 完整版）
 *
 * 迁移自参考仓库 src/runtime/workflow-runtime.ts（SHA 3373d1a），按 V1 执行文档裁剪。
 *
 * P0：args / phase / log / agent / parallel / sequence / setConcurrency / 阶段失败闸门
 * P1：fallback / race / workflow（子流程）/ check / verify / retry + fileExists / commandSuccess
 * P2：journal / resume / checkpoint（计划）
 *
 * 关键语义（与参考仓库一致）：
 *  - agent 可恢复失败重试耗尽 → 返回 null + 登记阶段失败闸门（不静默成功）
 *  - parallel：recoverable 塌缩 null；non-recoverable 上抛
 *  - sequence：抛出型可恢复失败立即停止；agent 耗尽 null 继续传递（闸门兜底）
 *  - fallback：串行竞争，首个 success 采纳；「null + 新增耗尽登记」视为候选失败换下一个
 *  - race：首个 success 胜出并 abort 兄弟候选（局部中止面经 ALS 传播）
 *  - workflow()：childSeq 同步领号（并行下 journal 身份稳定）、自环/深度检查、structuredClone 边界
 */

import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { createLimiter } from "./semaphore.js";
import { parseWorkflowScript, runScriptInVm } from "./vm.js";
import { WorkflowError, WorkflowErrorCode, wrapError } from "./errors.js";
import { createNodeExecutor, compositeScopeStorage, type WorkflowNode } from "./node-contract.js";
import type { AgentSessionRunner, AgentRunOptions } from "../agent/session-runner.js";
import type { AgentRecord, AgentUsage, JournalEntry, WorkflowMeta, WorkflowRunResult } from "./types.js";
import { buildOutputPreview, truncatePromptForJournal } from "./agent-result.js";
import { createEventEmitter, type EventEmitter } from "../events/emitter.js";
import type { WorkflowEventSink } from "../events/types.js";
import { createHash } from "node:crypto";

/** 运行时最大并发 */
export const MAX_CONCURRENCY = 16;
/** 单次 run 的 agent 总数上限（可被 options.maxAgents 覆盖） */
export const MAX_AGENTS_PER_RUN = 1000;
/** 可恢复失败的最大自动重试次数 */
export const MAX_AGENT_RETRIES = 3;
/** 子 workflow 嵌套深度上限 */
export const MAX_WORKFLOW_DEPTH = 3;

/** 脚本内 agent() 的可选项 */
export interface ScriptAgentOptions {
  label?: string;
  phase?: string;
  /** JSON Schema（对象字面量），要求结构化输出 */
  schema?: Record<string, unknown>;
  /** agent 类型：缺省 explore（只读分析型），写类任务显式传 general */
  agentType?: string;
  /** "provider/modelId" 或裸 "modelId"；缺省用运行级默认模型 */
  model?: string;
  /** 本 agent 的超时毫秒数；null 表示不设硬超时 */
  timeoutMs?: number | null;
  /** 本 agent 的重试次数（可恢复失败后） */
  retries?: number;
}

/** workflow() 的 ref：字符串路径或对象形式（label 为实例显示名） */
export type WorkflowRef = string | { scriptPath: string; label?: string };

export interface WorkflowRunOptions {
  /** 暴露给脚本的 args 全局 */
  args?: unknown;
  /** 注入缝：真实实现为 PiAgentAdapter；测试注入 fake runner */
  agent: AgentSessionRunner;
  concurrency?: number;
  maxAgents?: number;
  /** 整个 run 的外部中断信号（CLI SIGINT / 调用方） */
  signal?: AbortSignal;
  /** run 级默认超时；null 表示无硬超时 */
  agentTimeoutMs?: number | null;
  /** run 级默认重试次数 */
  agentRetries?: number;
  runId?: string;
  /** 项目基准目录（相对路径解析基准；缺省 process.cwd()） */
  cwd?: string;
  /** 阶段失败闸门逃生口：true 恢复旧行为——agent 重试耗尽返回 null 静默继续；缺省 false */
  continueOnAgentFailure?: boolean;
  /** 子 workflow 嵌套深度上限（缺省 MAX_WORKFLOW_DEPTH=3） */
  maxWorkflowDepth?: number;
  /** 根脚本路径（相对子脚本引用的解析基准之一 + 自环检测；缺省仅用 cwd） */
  scriptPath?: string;
  /** resume：上一轮的 journal（root key 为 runId:callIndex，child 为 runId:wfK:callIndex） */
  resumeJournal?: Map<string, JournalEntry>;
  /** 每个成功 live agent/checkpoint 完成后回调，调用方负责持久化 */
  onAgentJournal?: (entry: JournalEntry & { key: string }) => void;
  /** checkpoint() 的人工确认通道（CLI 接 readline；缺省走等待态策略） */
  confirm?: (promptText: string) => Promise<unknown>;
  /** 事件消费方（CLI 展示 / JSONL 持久化 / V2 SSE 同源） */
  onEvent?: WorkflowEventSink;
  /** resume 续接序号（同 runId 的事件序列连续；缺省 0） */
  eventSequenceStart?: number;
}

/** checkpoint() 的可选项（P2 实现运行时；类型先占位保持向前兼容） */
export interface CheckpointOptions {
  default?: unknown;
  headless?: "default" | "abort";
}

/** 并发闸门封装：limiter 与 concurrency 两份状态不可能失同步；仅 agent dispatch 进入 */
export interface SharedScheduler {
  /** 唯一的并发入口：只包 agent() dispatch；编排原语永远不进入（死锁防线） */
  run<T>(task: () => Promise<T>): Promise<T>;
  getConcurrency(): number;
  setConcurrency(value: number): void;
}

function createSharedScheduler(initial: number, onChange: (from: number, to: number) => void): SharedScheduler {
  let concurrency = initial;
  const limiter = createLimiter(initial);
  return {
    run: (task) => limiter(task),
    getConcurrency: () => concurrency,
    setConcurrency(value) {
      const next = Math.min(MAX_CONCURRENCY, value);
      if (next !== concurrency) {
        const from = concurrency;
        concurrency = next;
        limiter.setLimit(next);
        onChange(from, next);
      }
    },
  };
}

/** 整棵 run（root + 全部 child scope）共享的资源层 */
interface SharedRunContext {
  runId: string;
  scheduler: SharedScheduler;
  maxAgents: number;
  agentCount: number;
  /** root 脚本异常即置位：与外部 signal 一起构成整 run 中止面 */
  aborted: boolean;
  signal?: AbortSignal;
  agentRunner: AgentSessionRunner;
  agents: AgentRecord[];
  logs: string[];
  phases: string[];
  agentTimeoutMs: number | null;
  agentRetries?: number;
  cwd: string;
  phaseFailed: Array<{ label: string; phase?: string; error: string }>;
  continueOnAgentFailure: boolean;
  maxWorkflowDepth: number;
  resumeJournal?: Map<string, JournalEntry>;
  onAgentJournal?: (entry: JournalEntry & { key: string }) => void;
  confirm?: (promptText: string) => Promise<unknown>;
  /** 事件发射器（per-run sequence 单调） */
  events: EventEmitter;
}

function createSharedRunContext(options: WorkflowRunOptions, runId: string): SharedRunContext {
  const shared: SharedRunContext = {
    runId,
    scheduler: undefined as never, // 下一行装配（闭包需要 shared.log）
    maxAgents: options.maxAgents ?? MAX_AGENTS_PER_RUN,
    agentCount: 0,
    aborted: false,
    signal: options.signal,
    agentRunner: options.agent,
    agents: [],
    logs: [],
    phases: [],
    agentTimeoutMs: options.agentTimeoutMs !== undefined ? options.agentTimeoutMs : null,
    agentRetries: options.agentRetries,
    cwd: options.cwd ?? process.cwd(),
    phaseFailed: [],
    continueOnAgentFailure: options.continueOnAgentFailure ?? false,
    maxWorkflowDepth: options.maxWorkflowDepth ?? MAX_WORKFLOW_DEPTH,
    resumeJournal: options.resumeJournal,
    onAgentJournal: options.onAgentJournal,
    confirm: options.confirm,
    events: createEventEmitter(runId, options.onEvent, options.eventSequenceStart ?? 0),
  };
  const initial = normalizeConcurrency(
    options.concurrency ?? Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2),
  );
  shared.scheduler = createSharedScheduler(initial, (from, to) => {
    shared.logs.push(`并发上限调整为 ${to}（原 ${from}）`);
  });
  return shared;
}

/** 单个 workflow invocation 的私有身份与游标 */
interface WorkflowScope {
  /** 定义身份：脚本 meta.name */
  name: string;
  /** 实例身份 / UI 名：调用方 label 或 meta.name */
  label: string;
  scriptPath?: string;
  /** 规范化绝对路径（自环检查用） */
  canonicalPath?: string;
  depth: number;
  /** phase 显示前缀：child 为 "▸ <label> / "，root 为空 */
  phasePrefix: string;
  currentPhase?: string;
  /** scope 私有调用序号 */
  callSeq: number;
  /** scope 私有 child 创建计数（与 callSeq 严格分离：journal 稳定性关键） */
  childSeq: number;
  /** scope 私有组合节点计数（展示寻址 cmpN） */
  compositeSeq: number;
  /** journal key 段：root 为 undefined，child 为 wfN */
  keySegment?: string;
  /** scope 私有回放边界：首个未命中 journal 的 callIndex（P2） */
  firstMiss: number;
  parent?: WorkflowScope;
  /** 展示身份链（label 数组） */
  pathLabels?: string[];
  /** 稳定身份链（keySegment 数组；root 为 ["root"]） */
  pathKeys?: string[];
}

/** journal key：root 为 runId:N；child 为全链段 runId:wfK:wfM:N（P2 journal 使用） */
function scopedKey(shared: SharedRunContext, scope: WorkflowScope, callIndex: number): string {
  return scope.keySegment
    ? `${shared.runId}:${scope.pathKeys!.slice(1).join(":")}:${callIndex}`
    : `${shared.runId}:${callIndex}`;
}

export async function runWorkflow<T = unknown>(
  script: string,
  options: WorkflowRunOptions,
): Promise<WorkflowRunResult<T>> {
  const started = Date.now();
  const runId = options.runId ?? `run-${started.toString(36)}`;
  const shared = createSharedRunContext(options, runId);
  const rootScope: WorkflowScope = {
    name: "root",
    label: "root",
    ...(options.scriptPath ? { scriptPath: options.scriptPath } : {}),
    ...(options.scriptPath ? { canonicalPath: path.resolve(options.scriptPath) } : {}),
    depth: 0,
    phasePrefix: "",
    callSeq: 0,
    childSeq: 0,
    compositeSeq: 0,
    firstMiss: Number.POSITIVE_INFINITY,
  };

  let meta: WorkflowMeta;
  let result: unknown;
  try {
    shared.events.emit("run.started", { payload: { name: "root" } });
    const outcome = await executeWorkflow(script, options.args, shared, rootScope);
    meta = outcome.meta;
    result = outcome.result;
    // 阶段失败闸门终检（在 run.completed 之前：闸门失败不得发 completed）
    if (shared.phaseFailed.length > 0) throw buildFailedGateError(shared.phaseFailed);
    if (shared.agentCount === 0) {
      throw new WorkflowError(
        "workflow 脚本必须至少调用一次 agent()（或经 workflow() 子流程间接调用）；纯计算请直接完成，不要用 workflow",
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }
    shared.events.emit("run.completed", { payload: { agentCount: shared.agentCount } });
  } catch (error) {
    const aborted =
      shared.aborted ||
      Boolean(shared.signal?.aborted) ||
      (error instanceof WorkflowError && error.code === WorkflowErrorCode.WORKFLOW_ABORTED);
    shared.events.emit(aborted ? "run.cancelled" : "run.failed", {
      payload: { error: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  }

  return {
    meta,
    result: result as T,
    logs: shared.logs,
    phases: shared.phases,
    agents: shared.agents,
    agentCount: shared.agentCount,
    durationMs: Date.now() - started,
    runId,
  };
}

/** 单个 workflow invocation 的执行体：独立 globals/args，共享资源层 */
async function executeWorkflow(
  script: string,
  args: unknown,
  shared: SharedRunContext,
  scope: WorkflowScope,
): Promise<{ meta: ReturnType<typeof parseWorkflowScript>["meta"]; result: unknown }> {
  const { meta, body } = parseWorkflowScript(script);

  // 路径身份链：root 补 [meta.name]/["root"]；child 在创建时已继承父链
  if (!scope.parent) {
    scope.pathLabels = [meta.name];
    scope.pathKeys = ["root"];
  }

  // 初始 phase（声明 meta.phases 时，首个 phase 之前的 agent 归入第一个声明的 phase）
  const initialPhase = meta.phases?.[0]?.title;
  if (initialPhase && !scope.parent) {
    shared.phases.push(initialPhase);
  }
  scope.currentPhase = initialPhase;

  const log = (message: string) => {
    shared.logs.push(String(message));
    shared.events.emit("log.appended", { payload: { message: String(message) } });
  };
  const isAborted = () =>
    shared.aborted || Boolean(shared.signal?.aborted) || Boolean(compositeScopeStorage.getStore()?.signal?.aborted);
  const throwIfAborted = () => {
    if (isAborted()) {
      throw new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
    }
  };

  const phase = (title: string) => {
    // 阶段失败闸门：上一阶段有 agent 重试耗尽 -> 此处即阶段边界，终止并报告
    if (shared.phaseFailed.length > 0) throw buildFailedGateError(shared.phaseFailed);
    scope.currentPhase = title;
    const display = scope.phasePrefix + title;
    if (!shared.phases.includes(display)) shared.phases.push(display);
    shared.events.emit("phase.started", {
      payload: { title: display, workflowScopePath: scope.pathKeys ?? ["root"] },
    });
  };

  const ensureAgentCapacity = () => {
    if (shared.agentCount >= shared.maxAgents) {
      throw new WorkflowError(
        `agent 数量超限 (${shared.agentCount}/${shared.maxAgents})；提高 maxAgents 或拆分任务`,
        WorkflowErrorCode.AGENT_LIMIT_EXCEEDED,
        { recoverable: false },
      );
    }
  };

  const defaultAgentLabel = (phaseTitle: string | undefined, index: number): string =>
    phaseTitle ? `${phaseTitle} agent ${index}` : `agent ${index}`;

  const agent = (prompt: string, agentOptions: ScriptAgentOptions = {}): Promise<unknown> => {
    let call: Promise<unknown>;
    if (typeof prompt !== "string" || !prompt.trim()) {
      call = Promise.reject(
        new WorkflowError("agent() 需要非空 prompt 字符串", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
          recoverable: false,
        }),
      );
    } else {
      call = agentImpl(prompt, agentOptions);
    }
    // 防"脚本忘了 await"的拒绝演变为 unhandledRejection
    call.catch(() => {});
    return call;
  };

  const agentImpl = async (prompt: string, scriptOptions: ScriptAgentOptions): Promise<unknown> => {
    throwIfAborted();
    ensureAgentCapacity();

    // 显示 phase（child 内带 "▸ label / " 前缀）
    const assignedPhase = scriptOptions.phase ?? scope.currentPhase;
    const displayPhase = scope.phasePrefix ? scope.phasePrefix + (assignedPhase ?? "") : assignedPhase;
    const modelSpec = scriptOptions.model;
    const callIndex = scope.callSeq++;
    shared.agentCount++;
    const label = scriptOptions.label?.trim() || defaultAgentLabel(assignedPhase, shared.agentCount);

    // 组合链标记：在组合节点内执行时携带 cmpN 链（纯展示）
    const compositePath = compositeScopeStorage.getStore()?.compositePath;
    const record: AgentRecord = {
      id: scopedKey(shared, scope, callIndex),
      label,
      ...(displayPhase ? { phase: displayPhase } : {}),
      status: "running",
      ...(scope.parent ? { workflowPath: scope.pathLabels, workflowScopePath: scope.pathKeys } : {}),
      ...(compositePath?.length ? { compositePath: [...compositePath] } : {}),
    };
    shared.agents.push(record);

    // ---- journal / resume（P2）：确定性哈希 + 最长未变前缀回放 ----
    // 哈希身份：prompt/model/phase/agentType/schema；key 为 scope 稳定身份（并行乱序完成不影响 key）
    const deltaKey = record.id;
    const callHash = hashAgentCall(prompt, scriptOptions, displayPhase);
    const cached = shared.resumeJournal?.get(deltaKey);
    const hashMatches = cached != null && cached.hash === callHash;
    // 空文本结果不回放：历史 journal 里的空串一律重跑
    const cachedEmpty = hashMatches && isEmptyTextResult(cached.result, scriptOptions.schema);
    if (hashMatches && !cachedEmpty && callIndex < scope.firstMiss) {
      record.status = "ok";
      record.replayed = true;
      record.model = cached.model;
      record.executionId = cached.executionId;
      record.attempt = cached.attempt;
      if (cached.outputType === "text" || cached.outputType === "structured") {
        record.outputType = cached.outputType;
      }
      shared.events.emit("node.replayed", { nodeId: record.id, payload: { label } });
      return cached.result;
    }
    if (!hashMatches || cachedEmpty) {
      scope.firstMiss = Math.min(scope.firstMiss, callIndex);
    }

    return shared.scheduler.run(async () => {
      // 时间戳在拿到并发槽位后才打——排队等待期不计时、不计入 durationMs
      record.startedAt = Date.now();
      shared.events.emit("node.started", {
        nodeId: record.id,
        payload: {
          label,
          phase: displayPhase,
          workflowScopePath: scope.pathKeys ?? ["root"],
          ...(compositePath?.length ? { compositePath } : {}),
        },
      });
      const agentStarted = record.startedAt;
      const timeout = scriptOptions.timeoutMs !== undefined ? scriptOptions.timeoutMs : shared.agentTimeoutMs;
      record.timeoutMs = timeout;
      const retries = normalizeAgentRetries(scriptOptions.retries ?? shared.agentRetries ?? 1);
      const maxAttempts = retries + 1;

      try {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          record.attempt = attempt;
          record.maxAttempts = maxAttempts;
          record.attemptStartedAt = Date.now();
          throwIfAborted();
          // 每次 attempt 一个独立 controller：超时只取消本次，run 级 abort 取消所有
          const attemptController = new AbortController();
          const onRunAbort = () => attemptController.abort();
          shared.signal?.addEventListener("abort", onRunAbort);
          // Composite 局部中止面：race 胜出后 abort 只取消兄弟候选
          compositeScopeStorage.getStore()?.signal?.addEventListener("abort", onRunAbort);
          const attemptStarted = Date.now();
          const executionId = `${record.id}:${attempt}`;
          try {
            const runOptions: AgentRunOptions = {
              label,
              phase: displayPhase,
              agentType: scriptOptions.agentType,
              model: modelSpec,
              schema: scriptOptions.schema,
              signal: attemptController.signal,
              onUsage: (usage: AgentUsage) => {
                record.tokens = (record.tokens ?? 0) + (usage.total ?? 0);
                record.cost = (record.cost ?? 0) + (usage.cost ?? 0);
                record.inputTokens = (record.inputTokens ?? 0) + (usage.input ?? 0);
                record.outputTokens = (record.outputTokens ?? 0) + (usage.output ?? 0);
              },
              onSessionCreated: (sessionId) => {
                record.sessionId = sessionId;
                shared.events.emit("agent.session.created", { nodeId: record.id, payload: { sessionId } });
              },
            };
            const execution = await withTimeout(shared.agentRunner.run(prompt, runOptions), timeout, label, () =>
              attemptController.abort(),
            );
            const value = execution.value;
            record.status = "ok";
            record.durationMs = Date.now() - agentStarted;
            record.model = modelSpec;
            record.executionId = executionId;
            record.sessionId = execution.sessionId;
            record.outputType = execution.type;
            record.outputPreview = buildOutputPreview(execution.value);
            shared.events.emit("node.completed", { nodeId: record.id, attempt, payload: { label } });
            // 成功且非空结果写入 journal 回放缓存；失败/null/空文本不进
            if (!isEmptyTextResult(value, scriptOptions.schema)) {
              shared.onAgentJournal?.({
                key: deltaKey,
                hash: callHash,
                result: value,
                model: modelSpec,
                label,
                workflowLabel: scope.parent ? scope.label : undefined,
                phase: displayPhase,
                agentType: scriptOptions.agentType,
                sessionId: execution.sessionId,
                prompt: truncatePromptForJournal(prompt),
                outputType: execution.type,
                executionId,
                attempt,
                startedAt: attemptStarted,
                durationMs: Date.now() - attemptStarted,
              });
            }
            return value;
          } catch (error) {
            if (isAborted()) {
              record.status = "aborted";
              record.durationMs = Date.now() - agentStarted;
              shared.events.emit("node.failed", { nodeId: record.id, attempt, payload: { label, error: "aborted" } });
              throw wrapError(error);
            }
            const workflowError = wrapError(error);
            if (!workflowError.recoverable) {
              record.status = "failed";
              record.error = workflowError.message;
              record.durationMs = Date.now() - agentStarted;
              shared.events.emit("node.failed", {
                nodeId: record.id,
                attempt,
                payload: { label, error: workflowError.message },
              });
              throw workflowError;
            }
            if (attempt >= maxAttempts) {
              record.status = "failed";
              record.error = workflowError.message;
              record.durationMs = Date.now() - agentStarted;
              shared.events.emit("node.failed", {
                nodeId: record.id,
                attempt,
                payload: { label, error: workflowError.message },
              });
              log(`agent "${label}" ${maxAttempts} 次尝试后失败: ${workflowError.code} ${workflowError.message}`);
              // 阶段失败闸门：登记待裁决——下一 phase() 边界或 run 终检触发终止报告；
              // fallback/race 成功吸收时清除
              if (!shared.continueOnAgentFailure) {
                shared.phaseFailed.push({ label, phase: displayPhase, error: workflowError.message });
              }
              return null;
            }
            log(`agent "${label}" 第 ${attempt} 次尝试失败，重试: ${workflowError.message}`);
          } finally {
            shared.signal?.removeEventListener("abort", onRunAbort);
            compositeScopeStorage.getStore()?.signal?.removeEventListener("abort", onRunAbort);
          }
        }
        return null;
      } finally {
        // 资源释放由 adapter 的 dispose 保证；P1 无 worktree
      }
    });
  };

  // ── workflow() 原语：子流程（P1） ──

  /** 规范化 workflow 脚本路径：父脚本目录优先，其次 shared.cwd；realpath + Windows 大小写归一（自环检查用） */
  const canonicalWorkflowPath = (p: string): string => {
    const candidates: string[] = [];
    if (scope.scriptPath) {
      candidates.push(path.resolve(path.dirname(path.resolve(scope.scriptPath)), p));
    }
    candidates.push(path.resolve(shared.cwd, p));
    // 取第一个真实存在的候选；都不存在则用最后一个（后续读盘报精确错误）
    let resolved = candidates[candidates.length - 1] as string;
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          resolved = candidate;
          break;
        }
      } catch {
        // 检查失败试下一个候选
      }
    }
    try {
      resolved = fs.realpathSync.native(resolved);
    } catch {
      // realpath 失败（文件不存在等）保留 resolve 结果
    }
    if (process.platform === "win32") resolved = resolved.toLowerCase();
    return resolved;
  };

  const workflow = async (ref: WorkflowRef, childArgs?: unknown): Promise<unknown> => {
    throwIfAborted();
    // [关键] 同步阶段首行领号：childSeq++ 必须发生在任何 await 之前——
    // parallel 下 resolve/parse 异步化会让 wfN 按完成顺序分配，身份不稳定
    const childIndex = scope.childSeq++;
    const keySegment = `wf${childIndex}`;

    let scriptPath: string;
    let label: string | undefined;
    if (typeof ref === "string") {
      scriptPath = ref;
    } else if (ref && typeof ref === "object" && typeof ref.scriptPath === "string") {
      scriptPath = ref.scriptPath;
      label = ref.label;
    } else {
      throw new WorkflowError(
        "workflow() 需要 scriptPath 字符串或 { scriptPath, label? } 对象",
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }

    const canonical = canonicalWorkflowPath(scriptPath);
    // 自环检查（先于深度检查："child 调祖先"报更具体的自环错）
    for (let s: WorkflowScope | undefined = scope; s; s = s.parent) {
      if (s.canonicalPath && s.canonicalPath === canonical) {
        throw new WorkflowError(
          `workflow 不能调用自身或祖先：${canonical}`,
          WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
          { recoverable: false },
        );
      }
    }

    // 深度限制
    if (scope.depth >= shared.maxWorkflowDepth) {
      throw new WorkflowError(
        `workflow() 嵌套深度超限（当前最多 ${shared.maxWorkflowDepth} 层子 workflow；可用 maxWorkflowDepth 参数调整）`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }

    let childScript: string;
    try {
      childScript = fs.readFileSync(canonical, "utf-8");
    } catch {
      throw new WorkflowError(
        `workflow() 子脚本不存在或不可读：${scriptPath}（解析为 ${canonical}）`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }

    // structuredClone 调用边界：child args 与 parent 传入对象无引用共享
    let clonedArgs: unknown;
    try {
      clonedArgs = structuredClone(childArgs ?? {});
    } catch {
      throw new WorkflowError(
        "workflow() 的 args 必须是 structured-clone-compatible 数据（object/array/string/number/boolean/null）",
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }

    const childMeta = parseWorkflowScript(childScript).meta;
    const childLabel = label?.trim() || childMeta.name;
    const childScope: WorkflowScope = {
      name: childMeta.name,
      label: childLabel,
      scriptPath,
      canonicalPath: canonical,
      depth: scope.depth + 1,
      phasePrefix: `▸ ${childLabel} / `,
      callSeq: 0,
      childSeq: 0,
      compositeSeq: 0,
      keySegment,
      parent: scope,
      firstMiss: Number.POSITIVE_INFINITY,
      pathLabels: [...(scope.pathLabels ?? []), childLabel],
      pathKeys: [...(scope.pathKeys ?? []), keySegment],
    };
    log(`workflow("${childLabel}") 启动（key=${keySegment}，script=${canonical}）`);
    try {
      const child = await executeWorkflow(childScript, clonedArgs, shared, childScope);
      log(`workflow("${childLabel}") 完成`);
      // 返回值同样克隆：child 结果不与 VM 内引用共享
      return structuredClone(child.result);
    } catch (error) {
      log(`workflow("${childLabel}") 失败：${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  };

  const parallel = async (thunks: Array<() => Promise<unknown>>) => {
    throwIfAborted();
    if (!Array.isArray(thunks)) throw new TypeError("parallel() 期望函数数组");
    if (thunks.some((thunk) => typeof thunk !== "function")) {
      throw new TypeError("parallel() 期望函数数组而非 Promise 数组，请用 () => agent(...) 包裹");
    }
    return Promise.all(
      thunks.map(async (thunk, index) => {
        try {
          return await thunk();
        } catch (error) {
          if (isAborted()) throw error;
          const workflowError = wrapError(error);
          // 不可恢复失败（脚本校验错/agent 超限）终止整个 run，不塌缩为 null
          if (!workflowError.recoverable) throw workflowError;
          log(`parallel[${index}] 失败: ${workflowError.message}`);
          return null;
        }
      }),
    );
  };

  const consoleShim = {
    log,
    info: log,
    warn: (m: unknown) => log(`[warn] ${String(m)}`),
    error: (m: unknown) => log(`[error] ${String(m)}`),
  };

  // ── Composite 组合节点（sequence/fallback/race） ──

  const assertCompositeNodes = (nodes: unknown, api: string): Array<WorkflowNode> => {
    if (!Array.isArray(nodes) || nodes.length === 0 || nodes.some((n) => typeof n !== "function")) {
      throw new TypeError(`${api}(nodes) 期望非空函数数组，请用 () => agent(...) 或 prev => workflow(...) 包裹`);
    }
    return nodes as Array<WorkflowNode>;
  };

  const executeNode = createNodeExecutor(isAborted);

  const throwCancelled = (): never => {
    throw new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
  };

  /** 组合节点公共骨架：同步领号 cmpN、ALS 注入组合链与（race 的）局部 signal */
  const runComposite = async (
    kind: "sequence" | "fallback" | "race",
    nodes: Array<WorkflowNode>,
    exec: (list: Array<WorkflowNode>) => Promise<{ value: unknown; failed: boolean }>,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    throwIfAborted();
    const list = assertCompositeNodes(nodes, kind);
    const id = `cmp${scope.compositeSeq++}`;
    const parentPath = compositeScopeStorage.getStore()?.compositePath;
    const compositePath = [...(parentPath ?? []), id];
    try {
      const outcome = await compositeScopeStorage.run({ signal, compositePath }, () => exec(list));
      return outcome.value;
    } catch (error) {
      throw error;
    }
  };

  /** sequence：串行传递执行，前一个节点的返回值作为下一个节点的入参 */
  const sequence = (nodes: Array<WorkflowNode>): Promise<unknown> =>
    runComposite("sequence", nodes, async (list) => {
      let value: unknown;
      for (const [index, node] of list.entries()) {
        const r = await executeNode(node, value);
        if (r.status === "success") {
          value = r.value;
          continue;
        }
        if (r.status === "cancelled") throwCancelled();
        // 可恢复失败：序列立即停止，返回 null（脚本可 if (!r) 判断）
        const message = r.error instanceof Error ? r.error.message : String(r.error);
        log(`sequence[${index}] 失败，序列停止: ${message}`);
        return { value: null, failed: true };
      }
      return { value, failed: false };
    });

  /** fallback：串行竞争，首个 success 结果返回；「null + 候选窗口内新增耗尽登记」视为候选失败 */
  const fallback = (nodes: Array<WorkflowNode>): Promise<unknown> =>
    runComposite("fallback", nodes, async (list) => {
      for (const [index, node] of list.entries()) {
        const before = shared.phaseFailed.length;
        const r = await executeNode(node, undefined);
        if (r.status === "success") {
          // 闸门归因：agent 耗尽失败以 null 值形态返回——「null + 候选窗口内新增登记」
          // 判定为本候选失败：回滚这批登记（已被换候选显式吸收），继续尝试下一候选
          const added = shared.phaseFailed.slice(before);
          if (r.value === null && added.length > 0) {
            shared.phaseFailed.length = before;
            log(`fallback[${index}] 候选返回 null 且有耗尽失败登记，视为候选失败换下一个`);
            continue;
          }
          // 阶段失败闸门：降级成功 = 失败已被显式吸收，清除登记
          if (shared.phaseFailed.length > 0) shared.phaseFailed = [];
          return { value: r.value, failed: false };
        }
        if (r.status === "cancelled") throwCancelled();
        // 可恢复失败：尝试下一候选；结构性错误已由 executeNode 上抛
        const message = r.error instanceof Error ? r.error.message : String(r.error);
        log(`fallback[${index}] 失败，尝试下一候选: ${message}`);
      }
      log("fallback 全部候选失败，返回 null");
      return { value: null, failed: true };
    });

  /** race：并行竞争，首个 success 胜出并取消其余候选 */
  const race = (nodes: Array<WorkflowNode>): Promise<unknown> => {
    const controller = new AbortController();
    return runComposite(
      "race",
      nodes,
      (list) =>
        new Promise<{ value: unknown; failed: boolean }>((resolve, reject) => {
          let settled = false;
          let failureCount = 0;
          /** 首个结论生效：后续到达（含被取消兄弟的迟到失败/取消）全部忽略 */
          const settle = (finish: () => void) => {
            if (settled) return;
            settled = true;
            finish();
          };
          list.forEach((node, index) => {
            const startLen = shared.phaseFailed.length;
            executeNode(node, undefined).then((result) => {
              // 闸门归因：「null + 本候选产生耗尽登记」不是真成功，
              // 回滚这批登记（被竞争吸收）并按可恢复失败参与竞争统计
              if (result.status === "success" && result.value === null && shared.phaseFailed.length > startLen) {
                shared.phaseFailed.length = startLen;
                return { status: "failure" as const, error: new Error("候选返回 null 且有耗尽失败登记") };
              }
              return result;
            }).then(
              (r) => {
                if (r.status === "success") {
                  settle(() => {
                    controller.abort();
                    log(`race[${index}] 胜出，取消其余 ${list.length - 1} 个候选`);
                    // 阶段失败闸门：败者的耗尽失败已被胜者吸收，清除登记
                    if (shared.phaseFailed.length > 0) shared.phaseFailed = [];
                    resolve({ value: r.value, failed: false });
                  });
                } else if (r.status === "cancelled") {
                  settle(() =>
                    reject(
                      new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, {
                        recoverable: true,
                      }),
                    ),
                  );
                } else {
                  failureCount++;
                  log(`race[${index}] 可恢复失败（${failureCount}/${list.length}）`);
                  if (failureCount === list.length) {
                    settle(() => {
                      log("race 全部候选失败，返回 null");
                      resolve({ value: null, failed: true });
                    });
                  }
                }
              },
              (structural) =>
                settle(() => {
                  controller.abort();
                  reject(structural);
                }),
            );
          });
        }),
      controller.signal,
    );
  };

  // ── check / 确定性 helpers（P1） ──

  /** check：确定性事实验证。true=SUCCESS；false=FAILURE（可恢复失败，与其他节点同构）；
   *  condition 自身 throw=结构性错误（检查代码的 bug 不许伪装成「验证未通过」）。
   *  职责分离：check 客观事实 / verify AI 质量判断 / checkpoint（P2）人工决定 */
  const check = async (
    condition: () => boolean | Promise<boolean>,
    message?: string,
  ): Promise<boolean> => {
    if (typeof condition !== "function") {
      throw new WorkflowError("check(condition, message?) 需要函数条件", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
        recoverable: false,
      });
    }
    let passed: boolean;
    try {
      passed = await condition();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new WorkflowError(
        `check 条件执行出错（不是验证未通过，是检查代码出错）：${reason}`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }
    if (passed === true) return true;
    throw new WorkflowError(message ?? "check 验证未通过", WorkflowErrorCode.CHECK_FAILED, { recoverable: true });
  };

  /** 文件/目录存在性（相对 shared.cwd） */
  const fileExists = (target: string): boolean => {
    if (typeof target !== "string" || !target.trim()) return false;
    return fs.existsSync(path.resolve(shared.cwd, target));
  };

  /** 命令退出码为 0（超时视为失败） */
  const commandSuccess = (command: string, timeoutMs = 30_000): Promise<boolean> => {
    return new Promise((resolve) => {
      if (typeof command !== "string" || !command.trim()) {
        resolve(false);
        return;
      }
      exec(command, { cwd: shared.cwd, timeout: timeoutMs, windowsHide: true }, (error) => resolve(!error));
    });
  };

  // ── verify / retry（P1） ──

  const VERIFY_SCHEMA: Record<string, unknown> = {
    type: "object",
    properties: { real: { type: "boolean" }, reason: { type: "string" } },
    required: ["real"],
  };

  /** 对抗式评审：多个 reviewer 尝试反驳 item，投票达阈值判真 */
  const verify = async (
    item: unknown,
    opts: { reviewers?: number; threshold?: number; lens?: string | string[] } = {},
  ): Promise<unknown> => {
    throwIfAborted();
    const reviewerSlots = normalizeQualityFanout(opts.reviewers, 2, "verify() reviewers");
    const threshold = opts.threshold ?? 0.5;
    const lenses = opts.lens ? (Array.isArray(opts.lens) ? opts.lens : [opts.lens]) : [];
    const claim = typeof item === "string" ? item : JSON.stringify(item);
    const votes = (
      await parallel(
        Array.from({ length: reviewerSlots }, (_v, i) => () =>
          agent(
            `Adversarially review whether the following is REAL/correct. Try to refute it; default to real=false if unsure.${lenses.length ? ` Focus lens: ${lenses[i % lenses.length]}.` : ""}\n\n${claim}`,
            { label: `verify ${i + 1}`, schema: VERIFY_SCHEMA },
          )),
      )
    ).filter(Boolean) as Array<{ real?: boolean; reason?: string }>;
    const realCount = votes.filter((v) => v?.real).length;
    return {
      real: votes.length > 0 && realCount / votes.length >= threshold,
      realCount,
      total: votes.length,
      votes,
    };
  };

  /** 有界重试糖：直到 until 通过或耗尽，返回最后一次结果（不抛错） */
  const retry = async (
    thunk: (attempt: number) => Promise<unknown> | unknown,
    opts: { attempts?: number; until?: (r: unknown) => boolean } = {},
  ): Promise<unknown> => {
    const attempts = Math.max(1, opts.attempts ?? 3);
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      last = await thunk(i);
      const accepted = !opts.until || opts.until(last);
      if (accepted) return last;
    }
    return last;
  };

  const normalizeQualityFanout = (value: unknown, fallback: number, optionName: string): number => {
    const count = value === undefined ? fallback : value;
    if (typeof count !== "number" || !Number.isFinite(count) || !Number.isInteger(count) || count < 1) {
      throw new TypeError(`${optionName} 必须是大于等于 1 的整数`);
    }
    return count;
  };

  // ── checkpoint()：人工审批（P2，确认型子集）──
  // 语义：等待态持久化；拒绝是硬停止（不可被 fallback/塔缩吞掉）；V1 无通道且无显式默认 → 等待态，绝不自动通过
  const checkpoint = async (promptText: string, checkpointOptions: CheckpointOptions = {}): Promise<unknown> => {
    throwIfAborted();
    if (typeof promptText !== "string") throw new TypeError("checkpoint(promptText, options?) 需要 prompt 字符串");
    const callIndex = scope.callSeq++;
    const journalKey = scopedKey(shared, scope, callIndex);
    const callHash = createHash("sha256")
      .update(JSON.stringify({ promptText, default: checkpointOptions.default ?? null, headless: checkpointOptions.headless ?? null }))
      .digest("hex");
    const displayPhase = scope.phasePrefix ? scope.phasePrefix + (scope.currentPhase ?? "") : scope.currentPhase;
    const cpRecord: AgentRecord = {
      id: journalKey,
      label: promptText.length > 24 ? `${promptText.slice(0, 24)}…` : promptText,
      ...(displayPhase ? { phase: displayPhase } : {}),
      status: "running",
      kind: "checkpoint",
      ...(scope.parent ? { workflowPath: scope.pathLabels, workflowScopePath: scope.pathKeys } : {}),
    };
    shared.agents.push(cpRecord);
    const finishCp = (status: AgentRecord["status"], error?: string, replayed?: boolean) => {
      cpRecord.status = status;
      cpRecord.durationMs = Date.now() - (cpRecord.startedAt ?? Date.now());
      if (error) cpRecord.error = error;
      if (replayed) cpRecord.replayed = true;
    };
    // 回放：确定性重现拒绝（改 prompt 文本才会重新询问）
    const cached = shared.resumeJournal?.get(journalKey);
    if (cached != null && cached.hash === callHash && callIndex < scope.firstMiss) {
      shared.agentCount++;
      if (cached.result === false) {
        finishCp("failed", "人工拒绝（回放）", true);
        throw new WorkflowError(
          `checkpoint 被人工拒绝（回放）："${promptText}"`,
          WorkflowErrorCode.CHECKPOINT_REJECTED,
          { recoverable: false },
        );
      }
      finishCp("ok", undefined, true);
      return cached.result;
    }
    if (cached == null || cached.hash !== callHash) {
      scope.firstMiss = Math.min(scope.firstMiss, callIndex);
    }
    shared.agentCount++;

    cpRecord.startedAt = Date.now();
    shared.events.emit("checkpoint.requested", { nodeId: journalKey, payload: { prompt: promptText } });
    let reply: unknown;
    if (shared.confirm) {
      try {
        reply = await shared.confirm(promptText);
      } catch (error) {
        if (isAborted()) {
          finishCp("aborted");
          throw wrapError(error);
        }
        throw error;
      }
    } else if (checkpointOptions.default !== undefined) {
      // 显式脚本级默认值是深思熟虑的选择，允许无通道时使用
      reply = checkpointOptions.default;
    } else {
      // V1 红线：无人工通道且无显式默认 → 等待态，绝不自动通过
      finishCp("failed", "等待人工确认（无交互通道）");
      throw new WorkflowError(
        `checkpoint 需要人工确认但当前无交互通道："${promptText}"（run 进入等待态，resume 后重新询问）`,
        WorkflowErrorCode.CHECKPOINT_WAITING,
        { recoverable: false },
      );
    }
    throwIfAborted();
    log(`checkpoint："${promptText}" -> ${JSON.stringify(reply)}`);
    shared.onAgentJournal?.({ key: journalKey, hash: callHash, result: reply });
    shared.events.emit("checkpoint.resolved", {
      nodeId: journalKey,
      payload: { prompt: promptText, approved: reply !== false },
    });
    // Human Reject 强停止：拒绝不是普通 failure——不可被 fallback 换候选、不可被 parallel 塔缩 null
    if (reply === false) {
      finishCp("failed", "人工拒绝");
      throw new WorkflowError(
        `checkpoint 被人工拒绝："${promptText}"（Human Reject：流程停止，不触发自动降级）`,
        WorkflowErrorCode.CHECKPOINT_REJECTED,
        { recoverable: false },
      );
    }
    finishCp("ok");
    return reply;
  };

  // 脚本内动态调节并发上限：非法值报错；超上限钳制并记日志
  const setConcurrency = (value: unknown) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || Math.floor(value) !== value) {
      throw new WorkflowError(
        `setConcurrency 需要正整数，收到 ${String(value)}`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }
    shared.scheduler.setConcurrency(value);
  };

  // globals：每次 invocation 独立构造（args 闭包绑定当前 scope）
  const globals: Record<string, unknown> = {
    agent,
    workflow,
    parallel,
    sequence,
    fallback,
    race,
    check,
    fileExists,
    commandSuccess,
    phase,
    log,
    args,
    setConcurrency,
    verify,
    retry,
    checkpoint,
    console: consoleShim,
  };

  try {
    const result = await runScriptInVm(body, scope.label, globals);
    return { meta, result };
  } catch (error) {
    // 仅 root 脚本异常置位整 run 中止面（child 失败不污染——父脚本可 fallback/捕获）
    if (!scope.parent) shared.aborted = true;
    throw error;
  }
}

/** 带超时的 Promise 竞争；onTimeout 在拒绝生效前触发，用于取消底层工作 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number | null,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  if (ms === null) return promise;

  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // 尽力清理，不掩盖超时错误
      }
      reject(
        new WorkflowError(
          `agent "${label}" 超时 (${ms}ms)；调大或省略 timeoutMs 允许更长运行`,
          WorkflowErrorCode.AGENT_TIMEOUT,
          { recoverable: true },
        ),
      );
    }, ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/** 阶段失败闸门错误：报告全部重试耗尽的 agent 明细 */
function buildFailedGateError(failures: Array<{ label: string; phase?: string; error: string }>): WorkflowError {
  const lines = failures
    .map((f) => `  [${f.phase ?? "-"}] ${f.label}: ${f.error}`)
    .join("\n");
  return new WorkflowError(
    `阶段失败闸门：${failures.length} 个 agent 重试耗尽，workflow 终止（continueOnAgentFailure=true 可恢复静默继续的旧行为）\n${lines}`,
    WorkflowErrorCode.WORKFLOW_FAILED,
    { recoverable: false },
  );
}

function normalizeConcurrency(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return 1;
  return Math.min(MAX_CONCURRENCY, Math.floor(value));
}

function normalizeAgentRetries(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(MAX_AGENT_RETRIES, Math.floor(value));
}

/** agent 调用的稳定身份哈希：prompt/model/phase/agentType/schema（scope 前缀已含在 phase） */
function hashAgentCall(prompt: string, options: ScriptAgentOptions, phase: string | undefined): string {
  const identity = JSON.stringify({
    prompt,
    model: options.model ?? null,
    phase: phase ?? null,
    agentType: options.agentType ?? null,
    schema: options.schema ?? null,
  });
  return createHash("sha256").update(identity).digest("hex");
}

/** 无 schema 且结果为空/纯空白字符串 → 视为空文本（不 journal、不回放） */
function isEmptyTextResult(result: unknown, schema: Record<string, unknown> | undefined): boolean {
  return schema === undefined && typeof result === "string" && result.trim().length === 0;
}
