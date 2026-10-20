export const meta = {
  name: "mt_fallback_race",
  description: "手动测试 C3/C4：真实故障注入（坏模型 spec）下的 fallback 换候选与 race 胜出",
  phases: [{ title: "fallback" }, { title: "race" }],
}

// 故障注入手法：给候选指定不存在的模型 spec（model not found = 可恢复失败，重试耗尽返回 null）
const BAD_MODEL = "no-such-provider/no-such-model"

phase("fallback")
// 候选 1 必然失败（坏模型 + 0 重试）→ 闸门登记 → fallback 归因换候选 2
const fb = await fallback([
  () => agent("this call must fail (bad model)", { label: "fb-bad", model: BAD_MODEL, retries: 0 }),
  () => agent("Reply with exactly: fallback-second-candidate-ok", { label: "fb-good", retries: 0 }),
])

phase("race")
// 坏分支快速失败（不获胜），好分支慢但成功 → 胜出
const rc = await race([
  () => agent("this call must fail fast (bad model)", { label: "race-bad", model: BAD_MODEL, retries: 0 }),
  () => agent("Count slowly to three in your head, then reply with exactly: race-winner-ok", {
    label: "race-good",
    retries: 0,
  }),
])

log(`fallback = ${JSON.stringify(fb)}`)
log(`race = ${JSON.stringify(rc)}`)
return { fallback: fb, race: rc }
