export const meta = {
  name: "mt_sequence",
  description: "手动测试 C2：顺序链——agent 产词 → 纯函数加工 → 第二个 agent 基于前项续写",
  phases: [{ title: "chain" }],
}

phase("chain")
const summary = await sequence([
  () => agent("Invent a short fictional product name for a workflow engine. Reply with the name only.", {
    label: "invent",
  }),
  (prev) => `The product is called "${String(prev)}".`,
  (tagline) =>
    agent(`Write a one-sentence tagline for this product: ${String(tagline)}. Reply with the tagline only.`, {
      label: "tagline",
    }),
])
return { summary }
