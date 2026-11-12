/**
 * 前缀确定性前置路由（市场分析方案 V2 P0-3，2026-11-12）
 *
 * 与 url-router 同层：确定性代码解析，不交给 LLM 猜。
 * 消息以声明触发词开头（如「市场分析: 企业知识库」）→ 直接产出候选
 * {workflowId, args:{<prefixArg>: topic}}，统一走 facade.executeWorkflow
 * （argsSchema 服务端强校验与授权链路原样生效；read-only 直启 / write 走审批或 autoApprove）。
 *
 * 语义：
 * - 触发词后须跟分隔符（半/全角冒号或空白）+ 非空主题（≤60 字符，去首尾空白）
 * - 多个 workflow 同时命中前缀 → null（歧义不猜）
 * - 未命中 / 主题为空 → null，调用方回落 IntentRouter（LLM）或 Agent 通道
 */

import type { WorkflowRegistration } from "../contracts/wx.js";

/** 触发词后的分隔符：半角冒号/全角冒号/空白（可组合，全消费） */
const SEP_RE = /^[\s:：]+/;

/** 主题上限（微信一句话主题，过长提示走 Agent 通道细聊） */
export const TOPIC_MAX = 60;

export interface PrefixRouteHit {
  workflowId: string;
  /** 注入参数名（registry 条目 prefixArg ?? "topic"） */
  argName: string;
  /** 解析出的主题（已 trim，非空） */
  topic: string;
}

/** Registry 最小接口（生产=WorkflowRegistry.all()；测试可注入 fake） */
export interface PrefixRouteRegistry {
  all(enabledOnly?: boolean): WorkflowRegistration[];
}

export function routeByPrefixDirect(text: string, registry: PrefixRouteRegistry): PrefixRouteHit | null {
  if (!text) return null;
  const declared = registry.all().filter((r) => Array.isArray(r.prefixTriggers) && r.prefixTriggers.length > 0);
  if (declared.length === 0) return null;

  const hits: PrefixRouteHit[] = [];
  for (const reg of declared) {
    for (const trigger of reg.prefixTriggers ?? []) {
      if (!text.startsWith(trigger)) continue;
      const rest = text.slice(trigger.length);
      const sep = rest.match(SEP_RE);
      // 触发词后必须紧跟分隔符（防「市场分析」四字恰好是别的词前缀）
      if (!sep) continue;
      const topic = rest.slice(sep[0].length).trim();
      if (!topic || topic.length > TOPIC_MAX) break; // 主题为空/过长：该 workflow 放弃，换下一触发词无意义
      hits.push({ workflowId: reg.workflowId, argName: reg.prefixArg ?? "topic", topic });
      break;
    }
  }
  if (hits.length !== 1) return null; // 零命中或歧义：回落
  return hits[0]!;
}
