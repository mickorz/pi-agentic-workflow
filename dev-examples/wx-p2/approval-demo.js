export const meta = {
  name: "approval_demo",
  description: "WX-P2 真机验收：审批卡 → 批准/拒绝分流",
  phases: [{ title: "prepare" }, { title: "approve" }, { title: "finish" }],
}

phase("prepare")
const first = await agent("Reply with exactly: 第一阶段完成，等待审批。", { label: "prepare" })

phase("approve")
// 微信端审批卡：批准 → true；拒绝 → 按 Runtime 拒绝语义停止
const approved = await checkpoint(`演示任务是否继续执行第二阶段？（计划：${first}）`)

phase("finish")
const second = await agent("Reply with exactly: 第二阶段完成（已批准）。", { label: "finish" })
return { first, approved, second }
