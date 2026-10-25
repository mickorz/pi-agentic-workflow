/**
 * 公众号工作流目录查询（确定性通道，设计 V2 §3 同族）：
 * 微信发送「查看公众号工作流」等固定话术 → 直接渲染 registry 当前 enabled 条目表格，
 * 不经 LLM（零延迟、零幻觉、与实际可用面严格一致）。
 */

import type { WorkflowRegistration } from "../contracts/wx.js";

/** 命中即目录查询；先 collapse 空白再匹配（用户可能带空格）。 */
export const WORKFLOW_CATALOG_RE =
  /^(?:查看|查|看看|显示|列出|发我)?公众号(?:的)?(?:工作流|流程)(?:表|列表|支持|有哪些|支持什么|支持啥)?$/;

const RISK_LABEL: Record<string, string> = {
  "read-only": "只读",
  write: "写入",
  "external-side-effect": "外部副作用",
};

/** 渲染当前支持的工作流一览（enabled 条目，registry 文件顺序即展示顺序）。 */
export function renderWorkflowCatalog(rows: WorkflowRegistration[]): string {
  const enabled = rows.filter((r) => r.enabled !== false);
  if (enabled.length === 0) return "当前没有启用的工作流。";
  const lines = [`📋 当前支持的工作流（${enabled.length} 条）`, ""];
  for (const r of enabled) {
    const trigger = r.examples?.[0] ?? r.keywords[0] ?? r.name;
    const risk = RISK_LABEL[r.riskLevel] ?? r.riskLevel;
    lines.push(`【${r.name}】${r.workflowId}`);
    lines.push(`　触发：${trigger}（${risk}）`);
  }
  return lines.join("\n");
}
