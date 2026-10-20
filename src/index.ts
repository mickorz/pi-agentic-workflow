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
export { validateJsonSchema, SchemaValidationError } from "./adapters/pi/schema-validator.js";
export type { SchemaIssue } from "./adapters/pi/schema-validator.js";

// 持久化（P2）
export { loadJournal, appendJournalEntry } from "./persistence/journal.js";
export {
  listRuns,
  readManifest,
  runDir,
  runsRoot,
  hashContent,
  hashArgs,
  isPidAlive,
} from "./persistence/run-store.js";
export type { RunManifest, RunStatus, RunListItem } from "./persistence/run-store.js";

// 事件（P3）
export { WORKFLOW_EVENT_SCHEMA_VERSION, isWorkflowEvent } from "./events/types.js";
export type { WorkflowEvent, WorkflowEventType, WorkflowEventSink } from "./events/types.js";
export { createEventEmitter } from "./events/emitter.js";
export { appendEvent, readEvents, validateEventSequence, eventsPath } from "./events/jsonl-sink.js";

// 引擎公共 API（P3）
export { createWorkflowEngine } from "./engine.js";
export type {
  WorkflowEngine,
  WorkflowInput,
  WorkflowHandle,
  RunSnapshot,
  CheckpointDecision,
  EngineConfig,
} from "./engine.js";

// checkpoint 通道
export { createTerminalCheckpointProvider } from "./checkpoint/terminal-provider.js";

// V2 应用服务层（Web 与 CLI 共用入口）
export { RunApplicationService, ServiceError, createRunApplicationService } from "./application/run-service.js";
export type { StartRunOptions, ResumeOptions, ServiceConfig, ServiceErrorCode, RunDetail } from "./application/run-service.js";
export { CheckpointService } from "./application/checkpoint-service.js";
export type {
  RunStatusV2,
  RunDecision,
  CheckpointRecordV2,
  StartRunInputV2,
  WorkflowEventV1,
} from "./contracts/web.js";
export { toV2Event } from "./contracts/web.js";

// wechat-dispatch（WX-P1）
export { WorkflowRegistry } from "./dispatch/registry.js";
export { IntentRouter, CONFIDENCE_GATE } from "./dispatch/intent-router.js";
export type { RoutingLLM } from "./dispatch/intent-router.js";
export { ConversationStore } from "./dispatch/conversation.js";
export { TaskStore } from "./dispatch/task-store.js";
export { Dispatcher } from "./dispatch/dispatcher.js";
export type { ExecutionService } from "./dispatch/dispatcher.js";
export { ModelRouter } from "./model-routing/model-router.js";
export type { ModelPoolConfig, ModelAvailability } from "./model-routing/model-router.js";
export { MessageInbox } from "./gateway/message-inbox.js";
export { WechatBotAdapter, CHAT_FALLBACK_REPLY } from "./gateway/wechat/bot-adapter.js";
export type { BotAdapter } from "./gateway/wechat/bot-adapter.js";
export { Notifier } from "./notify/notifier.js";
export type {
  Intent,
  Action,
  RiskLevel,
  BotInboundMessage,
  BotMessageReceipt,
  WorkflowRegistration,
  RoutePlan,
  ConversationState,
  TaskBinding,
  ModelRoutingDecision,
  ModelTier,
  PlanInput,
  ExecutionAuthorization,
  ExecuteResult,
} from "./contracts/wx.js";
export { DispatchError } from "./contracts/wx.js";
