export const meta = { name: "long_demo", description: "40 agents" };
phase("loop")
const out = []
for (let i = 0; i < 40; i++) out.push(await agent("step " + i, { label: "s" + i }))
return { steps: out.length }
