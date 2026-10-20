export const meta = {
  name: "mt_timeout",
  description: "手动测试 G6：agent 超时（AGENT_TIMEOUT 可恢复失败 → 重试耗尽 → 阶段失败闸门终止）",
  phases: [{ title: "slow" }],
}

phase("slow")
// 要求长输出 + 3 秒硬超时 + 0 重试：必然超时 → 闸门终止（退出码 1，绝不静默成功）
const slow = await agent(
  "Write a very detailed 3000-word essay about the history of computing.",
  { label: "slow-agent", timeoutMs: 3000, retries: 0 },
)
return { slow }
