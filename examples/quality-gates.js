export const meta = {
  name: "quality_gates",
  description: "P1 质量门禁：check 确定性验证 + verify 独立 AI 审查",
  phases: [{ title: "produce" }, { title: "verify" }],
}

phase("produce")
const fact = await agent("State one easily checkable fact: the capital of France. Reply with just the city name.", {
  label: "produce-fact",
})

phase("verify")
// 确定性检查：命令成功（客观事实）
const cmdOk = await check(() => commandSuccess("echo quality-gates-ok"), "echo 命令应成功")

// AI 对抗式审查：独立 reviewer 会话投票
const verdict = await verify(fact, { reviewers: 2, threshold: 0.5 })

return { fact, cmdOk, verdict }
