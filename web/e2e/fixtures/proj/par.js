export const meta = { name: "par_demo", description: "phase + parallel agents" };
phase("fan-out")
const [a, b] = await parallel([
  () => agent("A", { label: "pa" }),
  () => agent("B", { label: "pb" }),
])
return { a, b }
