export const meta = {
  name: "smoke",
  description: "P0 冒烟：单 agent 返回一句话",
  phases: [{ title: "check" }],
}

phase("check")
const answer = await agent("Reply with exactly this sentence and nothing else: pi-workflow smoke ok", {
  label: "smoke-agent",
})
log(`agent said: ${answer}`)
return { answer }
