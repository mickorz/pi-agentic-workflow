export const meta = {
  name: "nested_child",
  description: "子流程：单 agent 总结主题（被 nested-parent 调用）",
}

const topic = args?.topic ?? "unknown"
const summary = await agent(`In one short sentence, summarize what ${topic} is.`, {
  label: `summarize-${topic}`,
})
return { topic, summary }
