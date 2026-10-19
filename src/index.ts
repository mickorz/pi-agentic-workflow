/**
 * pi-agentic-workflow 公共核心 API
 *
 * Core 不依赖 CLI；第三方 TS 程序可经本入口独立调用引擎。
 */

// 编排核心
export { runWorkflow } from "./runtime/workflow-runtime.js";
export type { WorkflowRunOptions, ScriptAgentOptions } from "./runtime/workflow-runtime.js";
export { parseWorkflowScript } from "./runtime/vm.js";
export { WorkflowError, WorkflowErrorCode, wrapError } from "./runtime/errors.js";
export type { AgentRecord, AgentUsage, WorkflowMeta, WorkflowRunResult } from "./runtime/types.js";

// 注入缝
export type { AgentSessionRunner, AgentRunOptions, AgentExecutionResult } from "./agent/session-runner.js";

// Pi Adapter（可选依赖；runtime 不 import 它）
export { PiAgentAdapter } from "./adapters/pi/pi-agent-adapter.js";
export type { PiAdapterOptions } from "./adapters/pi/pi-agent-adapter.js";
export { resolveToolProfile, EXPLORE_TOOLS, GENERAL_TOOLS, KNOWN_AGENT_TYPES } from "./adapters/pi/tool-profiles.js";
