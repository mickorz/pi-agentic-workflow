export const meta = {
  name: "mt_smoke",
  description: "手动测试 A/B1：单 agent 冒烟（最小可用验证）",
  phases: [{ title: "check" }],
}

phase("check")
const answer = await agent("Reply with exactly this sentence and nothing else: manual test smoke ok", {
  label: "smoke-agent",
})
log(`agent said: ${answer}`)
return { answer }
