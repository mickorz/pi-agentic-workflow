export const meta = {
  name: "sequence_demo",
  description: "P0 顺序链：agent 产出演变 -> 纯函数加工 -> 第二个 agent 基于前项结果续写",
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
