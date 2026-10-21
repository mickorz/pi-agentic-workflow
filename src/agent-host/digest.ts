/**
 * 稳定摘要（AM-P0 T3）：args/registry 元数据的确定性哈希
 * - PendingAction 确认时重校验 argsDigest 一致（§3.2：不依赖会话记忆）
 * - Registry 无版本字段，用注册元数据稳定哈希替代（§3.1 registryDigest）
 */

import { createHash } from "node:crypto";
import type { WorkflowRegistry } from "../dispatch/registry.js";

/** 递归键排序的稳定序列化（对象键序无关） */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** 参数快照摘要（确认时比对：参数被篡改即拒绝） */
export function computeArgsDigest(args: unknown): string {
  return sha256Hex(stableStringify(args ?? null)).slice(0, 16);
}

/** 注册元数据稳定哈希（启用项按 workflowId 排序；plan 与 execute 间隔内注册变化可检出） */
export function computeRegistryDigest(registry: WorkflowRegistry): string {
  const rows = registry
    .all(true)
    .map((r) => ({
      workflowId: r.workflowId,
      scriptPath: r.scriptPath,
      name: r.name,
      description: r.description,
      argsSchema: r.argsSchema,
      riskLevel: r.riskLevel,
      keywords: [...r.keywords].sort(),
    }))
    .sort((a, b) => (a.workflowId < b.workflowId ? -1 : 1));
  return sha256Hex(stableStringify(rows)).slice(0, 16);
}
