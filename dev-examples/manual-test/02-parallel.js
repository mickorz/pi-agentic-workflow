export const meta = {
  name: "mt_parallel",
  description: "手动测试 C1：并行执行 + args 注入 + 结果按索引返回",
  phases: [{ title: "fan-out" }],
}

phase("fan-out")
const topics = args?.topics ?? ["redis", "sqlite", "kafka"]
log(`topics = ${JSON.stringify(topics)}`)
const answers = await parallel(
  topics.map((topic) => () =>
    agent(`In one short sentence, what is ${topic}?`, { label: `explain-${topic}` }),
  ),
)
return { topics, answers }
