/**
 * Workflow Runtime —— 宿主无关的编排核心（P0 子集）
 *
 * 迁移自参考仓库 src/runtime/workflow-runtime.ts（SHA 3373d1a），按 V1 执行文档裁剪：
 *  P0 支持：args / phase / log / agent / parallel / sequence / setConcurrency
 *  P1 增加：fallback / race / workflow / check / verify / retry 及确定性 helpers
 *  P2 增加：journal / resume / checkpoint
 *
 * 执行流程：
 *  runWorkflow(script, options)
 *   -> createSharedRunContext
 *   -> executeWorkflow(script, args, shared)
 *        -> parseWorkflowScript 校验 meta 信封 + 剥离
 *        -> runScriptInVm（DETERMINISM_PRELUDE + body）
 *             -> agent() 依次经过：abort 检查 -> maxAgents 配额 -> scheduler 排队
 *                  -> withTimeout 包装 -> 可恢复错误重试 -> AgentSessionRunner.run（注入缝）
 *             -> parallel()：recoverable 失败塌缩为 null，non-recoverable 上抛
 *             -> sequence()：Composite 组合节点——经 executeNode 三态判定，
 *                  success 继续 / 可恢复失败停止（返回 null）/ 中止上抛
 *   -> 汇总 AgentRecord / logs / phases / token 用量 返回
 *
 * 阶段失败闸门（语义与参考仓库 Bug1 修复一致）：
 *  agent 重试耗尽返回 null 后，run 不静默成功——下一 phase() 边界或 run 终检
 *  抛 WORKFLOW_FAILED；continueOnAgentFailure=true 可恢复静默继续的旧行为。
 */

import { createLimiter } from "./semaphore.js";
import { parseWorkflowScript, runScriptInVm } from "./vm.js";
import { WorkflowError, WorkflowErrorCode, wrapError } from "./errors.js";
import { createNodeExecutor, compositeScopeStorage, type WorkflowNode } from "./node-contract.js";
import type { AgentSessionRunner, AgentRunOptions } from "../agent/session-runner.js";
import type { AgentRecord, AgentUsage, WorkflowRunResult } from "./types.js";
import { truncateUtf8ByBytes, redactValue } from "./agent-result.js";

/** 运行时最大并发 */
export const MAX_CONCURRENCY = 16;
/** 单次 run 的 agent 总数上限（可被 options.maxAgents 覆盖） */
export const MAX_AGENTS_PER_RUN = 1000;
/** 可恢复失败的最大自动重试次数 */
export const MAX_AGENT_RETRIES = 3;

/** 脚本内 agent() 的可选项（比 AgentRunOptions 少 signal/onUsage 等宿主注入项） */
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

/** 整棵 run 共享的资源层 */
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
  /** 阶段失败闸门明细：非空 = 有 agent 重试耗尽待裁决；下一 phase() 或 run 终检触发终止 */
  phaseFailed: Array<{ label: string; phase?: string; error: string }>;
  continueOnAgentFailure: boolean;
  compositeSeq: number;
  /** run 级调用序号（P0 单 scope；P1 child workflow 时迁移到 scope 私有） */
  callSeq: number;
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
    compositeSeq: 0,
    callSeq: 0,
  };
  const initial = normalizeConcurrency(
    options.concurrency ?? Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2),
  );
  shared.scheduler = createSharedScheduler(initial, (from, to) => {
    shared.logs.push(`并发上限调整为 ${to}（原 ${from}）`);
  });
  return shared;
}

export async function runWorkflow<T = unknown>(
  script: string,
  options: WorkflowRunOptions,
): Promise<WorkflowRunResult<T>> {
  const started = Date.now();
  const runId = options.runId ?? `run-${started.toString(36)}`;
  const shared = createSharedRunContext(options, runId);

  const { meta, result } = await executeWorkflow(script, options.args, shared);

  // 阶段失败闸门终检：失败发生在最后一个 phase 且脚本正常 return 时，不允许静默成功
  if (shared.phaseFailed.length > 0) throw buildFailedGateError(shared.phaseFailed);
  // 纯编排非法：run 级至少一次实际 agent dispatch
  if (shared.agentCount === 0) {
    throw new WorkflowError(
      "workflow 脚本必须至少调用一次 agent()（纯计算请直接完成，不要用 workflow）",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
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

/** 单个 workflow 的执行体（P0 无 child workflow：单 scope） */
async function executeWorkflow(
  script: string,
  args: unknown,
  shared: SharedRunContext,
): Promise<{ meta: ReturnType<typeof parseWorkflowScript>["meta"]; result: unknown }> {
  const { meta, body } = parseWorkflowScript(script);

  // 初始 phase（声明 meta.phases 时，首个 phase 之前的 agent 归入第一个声明的 phase）
  const initialPhase = meta.phases?.[0]?.title;
  if (initialPhase) {
    shared.phases.push(initialPhase);
  }

  const log = (message: string) => {
    shared.logs.push(String(message));
  };
  const isAborted = () =>
    shared.aborted || Boolean(shared.signal?.aborted) || Boolean(compositeScopeStorage.getStore()?.signal?.aborted);
  const throwIfAborted = () => {
    if (isAborted()) {
      throw new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
    }
  };

  let currentPhase = initialPhase;
  const phase = (title: string) => {
    // 阶段失败闸门：上一阶段有 agent 重试耗尽 -> 此处即阶段边界，终止并报告
    if (shared.phaseFailed.length > 0) throw buildFailedGateError(shared.phaseFailed);
    currentPhase = title;
    if (!shared.phases.includes(title)) shared.phases.push(title);
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

    const assignedPhase = scriptOptions.phase ?? currentPhase;
    const modelSpec = scriptOptions.model;
    const callIndex = shared.callSeq++;
    shared.agentCount++;
    const label = scriptOptions.label?.trim() || defaultAgentLabel(assignedPhase, shared.agentCount);

    const record: AgentRecord = {
      id: `${shared.runId}:${callIndex}`,
      label,
      ...(assignedPhase ? { phase: assignedPhase } : {}),
      status: "running",
    };
    shared.agents.push(record);

    return shared.scheduler.run(async () => {
      // 时间戳在拿到并发槽位后才打——排队等待期不计时、不计入 durationMs
      record.startedAt = Date.now();
      const agentStarted = record.startedAt;
      const timeout = scriptOptions.timeoutMs !== undefined ? scriptOptions.timeoutMs : shared.agentTimeoutMs;
      record.timeoutMs = timeout;
      // 缺省重试 1 次（可恢复失败一次即静默返回 null 会放大「不重试直接过」体感）
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
          compositeScopeStorage.getStore()?.signal?.addEventListener("abort", onRunAbort);
          const attemptStarted = Date.now();
          const executionId = `${record.id}:${attempt}`;
          try {
            const runOptions: AgentRunOptions = {
              label,
              phase: assignedPhase,
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
            return value;
          } catch (error) {
            if (isAborted()) {
              record.status = "aborted";
              record.durationMs = Date.now() - agentStarted;
              throw wrapError(error);
            }
            const workflowError = wrapError(error);
            if (!workflowError.recoverable) {
              record.status = "failed";
              record.error = workflowError.message;
              record.durationMs = Date.now() - agentStarted;
              throw workflowError;
            }
            if (attempt >= maxAttempts) {
              record.status = "failed";
              record.error = workflowError.message;
              record.durationMs = Date.now() - agentStarted;
              log(`agent "${label}" ${maxAttempts} 次尝试后失败: ${workflowError.code} ${workflowError.message}`);
              // 阶段失败闸门：登记待裁决——下一 phase() 边界或 run 终检触发终止报告
              if (!shared.continueOnAgentFailure) {
                shared.phaseFailed.push({ label, phase: assignedPhase, error: workflowError.message });
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
        // P0：无 worktree；资源释放由 adapter 的 dispose 保证
      }
    });
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

  // ── Composite 组合节点（P0 仅 sequence）：纯控制层，不碰 callSeq/agentCount ──

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

  /** sequence：串行传递执行，前一个节点的返回值作为下一个节点的入参 */
  const sequence = (nodes: Array<WorkflowNode>): Promise<unknown> => {
    throwIfAborted();
    const list = assertCompositeNodes(nodes, "sequence");
    const id = `cmp${shared.compositeSeq++}`;
    const parentPath = compositeScopeStorage.getStore()?.compositePath;
    const compositePath = [...(parentPath ?? []), id];
    return compositeScopeStorage.run({ compositePath }, async () => {
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
        return null;
      }
      return value;
    });
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

  // globals：args 闭包绑定
  const globals: Record<string, unknown> = {
    agent,
    parallel,
    sequence,
    phase,
    log,
    args,
    setConcurrency,
    console: consoleShim,
  };

  try {
    const result = await runScriptInVm(body, meta.name, globals);
    return { meta, result };
  } catch (error) {
    // root 脚本异常置位整 run 中止面（拦住未 await 的 parallel 兄弟分支继续 dispatch）
    shared.aborted = true;
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

/** 无 schema 且结果为空/纯空白字符串 → 视为空文本 */
function isEmptyTextResult(result: unknown, schema: Record<string, unknown> | undefined): boolean {
  return schema === undefined && typeof result === "string" && result.trim().length === 0;
}
void isEmptyTextResult;

function normalizeAgentRetries(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(MAX_AGENT_RETRIES, Math.floor(value));
}

/** 展示用预览（脱敏 + 2KB 截断；语义同参考仓库 agent-result.ts） */
function buildOutputPreview(value: unknown, maxBytes = 2048): string {
  let text: string;
  try {
    if (typeof value === "string") {
      text = value;
    } else {
      const serialized = JSON.stringify(redactValue(value), null, 2);
      text = serialized === undefined ? String(value) : serialized;
    }
  } catch {
    text = String(value);
  }
  return truncateUtf8ByBytes(text, maxBytes);
}
