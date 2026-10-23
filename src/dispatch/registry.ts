/**
 * Workflow Registry（WR-001~004）：注册/校验/检索/启用白名单
 * 注册文件：JSON（.pi-wechat/workflows.json，字段=WorkflowRegistration[]）
 */

import fs from "node:fs";
import path from "node:path";
import type { WorkflowRegistration } from "../contracts/wx.js";

export class WorkflowRegistry {
  private readonly byId = new Map<string, WorkflowRegistration>();

  constructor(registrations: WorkflowRegistration[]) {
    for (const reg of registrations) this.register(reg);
  }

  /** WR-003：错误元数据不入表（负例拒绝并计数） */
  register(reg: WorkflowRegistration): { ok: true } | { ok: false; error: string } {
    if (!reg.workflowId || typeof reg.workflowId !== "string") return { ok: false, error: "workflowId 必填" };
    if (!/^[a-z][a-z0-9-]*$/.test(reg.workflowId)) return { ok: false, error: `workflowId 非法：${reg.workflowId}` };
    if (this.byId.has(reg.workflowId)) return { ok: false, error: `重复注册：${reg.workflowId}` };
    if (!reg.scriptPath || typeof reg.scriptPath !== "string") return { ok: false, error: "scriptPath 必填" };
    if (path.isAbsolute(reg.scriptPath) || reg.scriptPath.includes("..")) {
      return { ok: false, error: `scriptPath 必须是白名单根内相对路径：${reg.scriptPath}` };
    }
    if (!reg.argsSchema || typeof reg.argsSchema !== "object") return { ok: false, error: "argsSchema 必填" };
    if (!["read-only", "write", "external-side-effect"].includes(reg.riskLevel)) {
      return { ok: false, error: `riskLevel 非法：${String(reg.riskLevel)}` };
    }
    // P1a Phase W（方案 §3）：capabilities 能力声明（如 "obsidian-write"）。
    // 写能力门槛重于风险等级：声明 obsidian-write 的注册项必须落在 write/external-side-effect，
    // 否则拒绝入表（read-only 工作流永不可触达写后端）
    if (reg.capabilities !== undefined) {
      if (!Array.isArray(reg.capabilities) || reg.capabilities.length === 0) {
        return { ok: false, error: `capabilities 需为非空字符串数组：${reg.workflowId}` };
      }
      const known = new Set<string>();
      for (const cap of reg.capabilities) {
        if (typeof cap !== "string" || !/^[a-z][a-z0-9-]*$/.test(cap)) {
          return { ok: false, error: `capabilities 条目非法（需 kebab-case）：${reg.workflowId}#${String(cap)}` };
        }
        if (known.has(cap)) return { ok: false, error: `capabilities 条目重复：${reg.workflowId}#${cap}` };
        known.add(cap);
      }
      if (reg.capabilities.includes("obsidian-write") && reg.riskLevel === "read-only") {
        return {
          ok: false,
          error: `capabilities 含 obsidian-write 但 riskLevel=read-only，写能力必须声明为 write/external-side-effect：${reg.workflowId}`,
        };
      }
    }
    // VR S4.4：anyOfArgs 声明式跨字段约束合法性（非空字符串数组，条目必须在 argsSchema.properties）
    if (reg.anyOfArgs !== undefined) {
      if (!Array.isArray(reg.anyOfArgs) || reg.anyOfArgs.length === 0) {
        return { ok: false, error: `anyOfArgs 需为非空字符串数组：${reg.workflowId}` };
      }
      const props = (reg.argsSchema as { properties?: Record<string, unknown> }).properties;
      for (const key of reg.anyOfArgs) {
        if (typeof key !== "string" || key.trim() === "") {
          return { ok: false, error: `anyOfArgs 条目必须是非空字符串：${reg.workflowId}` };
        }
        if (!props || typeof props !== "object" || !(key in props)) {
          return {
            ok: false,
            error: `anyOfArgs 条目 ${key} 必须存在于 argsSchema.properties：${reg.workflowId}`,
          };
        }
      }
    }
    this.byId.set(reg.workflowId, {
      ...reg,
      keywords: reg.keywords ?? [],
      ...(reg.capabilities ? { capabilities: [...reg.capabilities] } : {}),
    });
    return { ok: true };
  }

  /** 运维下线/启用（execute 重校验场景：plan 与 execute 间隔内可变更） */
  setEnabled(workflowId: string, enabled: boolean): boolean {
    const reg = this.byId.get(workflowId);
    if (!reg) return false;
    reg.enabled = enabled;
    return true;
  }

  /** WR-002：仅启用项可见（白名单） */
  get(workflowId: string): WorkflowRegistration | undefined {
    const reg = this.byId.get(workflowId);
    return reg?.enabled ? reg : undefined;
  }

  all(enabledOnly = true): WorkflowRegistration[] {
    return [...this.byId.values()].filter((r) => (enabledOnly ? r.enabled : true));
  }

  /** IR 候选检索：关键词/名称/描述包含匹配（IR-010 初期关键词通道） */
  search(text: string, limit = 8): WorkflowRegistration[] {
    const lower = text.toLowerCase();
    const scored: Array<{ reg: WorkflowRegistration; score: number }> = [];
    for (const reg of this.all()) {
      let score = 0;
      for (const kw of reg.keywords) if (lower.includes(kw.toLowerCase())) score += 2;
      if (lower.includes(reg.name.toLowerCase())) score += 2;
      if (reg.description && lower.includes(reg.description.toLowerCase().slice(0, 12))) score += 1;
      if (score > 0) scored.push({ reg, score });
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.reg);
  }

  /** 从 JSON 文件加载（错误条目跳过并返回问题清单） */
  static loadFromFile(file: string): { registry: WorkflowRegistry; issues: string[] } {
    const issues: string[] = [];
    const raw = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf-8")) as WorkflowRegistration[]) : [];
    const registry = new WorkflowRegistry([]);
    for (const reg of raw) {
      const result = registry.register(reg);
      if (!result.ok) issues.push(`${(reg as { workflowId?: string }).workflowId ?? "?"}: ${result.error}`);
    }
    return { registry, issues };
  }
}
