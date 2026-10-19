/**
 * 工具权限 profile：explore 只读 / general 可写（V1 执行文档 §2.6）
 *
 * 权限由工具执行层严格落实（tools 白名单），不依赖系统提示词。
 * Bash 可绕过只读限制——explore 不配 bash。
 */

/** explore：只读分析型（缺省 profile） */
export const EXPLORE_TOOLS = ["read", "grep", "find", "ls"] as const;
/** general：可写型（read/bash/edit/write） */
export const GENERAL_TOOLS = ["read", "bash", "edit", "write"] as const;

/** 已知 agent 类型表 */
export const KNOWN_AGENT_TYPES = ["explore", "general"] as const;

/**
 * 解析 agentType 到工具白名单。
 * 缺省/未知类型的行为：
 *  - undefined → explore（安全缺省）
 *  - "explore" / "general" → 对应 profile
 *  - 其他 → 抛结构性错误（脚本写错 agentType 不应静默降级）
 */
export function resolveToolProfile(agentType: string | undefined): string[] {
  switch (agentType) {
    case undefined:
    case "explore":
      return [...EXPLORE_TOOLS];
    case "general":
      return [...GENERAL_TOOLS];
    default:
      throw new Error(
        `unknown agentType "${agentType}"（已知类型：${KNOWN_AGENT_TYPES.join(", ")}）`,
      );
  }
}
