export const meta = {
  name: "parallel_demo",
  description: "P0 并行：两个 agent 同时执行，返回按输入次序排列",
  phases: [{ title: "fan-out" }],
}

phase("fan-out")
const topics = args?.topics ?? ["redis", "sqlite"]
const answers = await parallel(
  topics.map((topic) => () =>
    agent(`In one short sentence, what is ${topic}?`, {
      label: `explain-${topic}`,
    }),
  ),
)
return { topics, answers }
